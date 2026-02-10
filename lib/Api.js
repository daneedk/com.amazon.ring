const Homey = require('homey');

const { RingApi, RingDeviceType } = require('./loadRingApi')();

const refreshTimeout       = 5000;
const cameraStatusInterval = 5;
const locationModeInterval = 5;
const alarmModeInterval    = 5;
const allowedModes         = ["home", "away", "disarmed"];
// Devicetypes for which data is emited
//                            Contact           Motion           Keypad             Alarm             Basestation
// const alarmDeviceList   = [ 'sensor.contact', 'sensor.motion', 'security-keypad', 'security-panel', 'hub.redsky' ];
const alarmDeviceList      = [ 'sensor.contact', 'sensor.motion', 'security-keypad', 'security-panel', 'hub.redsky' ];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Api extends Homey.SimpleClass {

    log(...args) { this.homey.log('[Api]', ...args); }

    constructor(homey) {
        super();

        this.homey = homey;
        this._refreshToken = null;
        this._uniqueid = null;
        this._authenticated = false;
        this._previousAuthenticated = null;
        this._authenticating = false;
        this._apiversion = 11;

        this.homey.settings.on('set', (name) => this._onSetSettings(name));
    }

    async init () {
        this.log('Api.js                     initialising ==============')

        let refreshToken = await this.homey.settings.get('ringRefreshToken');

        this.homey.api.realtime('com.ring.status', { state: 'api_init'});
        await this.homey.cloud.getHomeyId()
            .then((cloudId) => {
                this._uniqueid = cloudId;

                this._refreshToken = refreshToken;

                this._verifyAuthentication()
                    .then(() => {
                            this.log('Api.js:                    initialising done =========')
                        }
                    )
                    .catch((error) => {
                            this.log('_verifyAuthentication:     Failed:',error)
                            this.log('Api.js:                    initialising done =========')
                            this.homey.emit('authenticationChanged', 'unauthenticated')
                        }
                    )                
            })
            .catch((error) => {return this.error(new Error('no_uniqueid'));})

    }

    async _connectRingAPI() {
        this.log('_connectRingAPI:           connecting ----------------');

        if (this.ringApi) {
            this.log('_connectRingAPI:           ring-client-api already connected, exit _connectRingAPI');
            return;
        }

        // Step 1
        // Initialse the ring-client-api, set up the connection and connect
        this.log('_connectRingAPI:           ring-client-api initializing');
        try {
            await this._initializeRingApi();
        } catch (error) {
            this.log('_connectRingAPI:           Error initializing ring-client-api', error);
            throw error;
        }
        this.log('_connectRingAPI:           Succesfully connected -----');

        // Step 2
        // Once connected, subscribe to Refresh Token updates
        this.log('_connectRingAPI:           subscribing to Refresh Token updates');
        await this._subRefreshTokenUpdates();

        // Step 3
        // Now let's get the locations and devices
        this.log('_connectRingAPI:           Subscribing to locations');
        try {
            // get all locations from the Ring api and subscribe to location information (interval on locationModeInterval)
            this.locations = await this.ringApi.getLocations();

            // Next line needs a fix, this.location is used in getAlarmDevices() when adding new devices§
            this.location = this.locations[0];

            this.log('_connectRingAPI:           Locations retrieved, Let\'s see which devices can be found');

            // Subscribe to the location modes and get the locations devices
            await this._subLocations(this.locations);
        }
        catch(error) {
            this.log('_connectRingAPI locations error',error);
            this.locations = null;
            this.ringApi = null;
            if ( error.toString().includes("Error: Refresh token is not valid.")) {
                this._authenticated = false;
                const report = JSON.parse('{"error": "refreshtoken not valid", "error_description": "The refreshtoken is invalid, please reauthenticate."}');
                this._setAuthenticationStatus(false, report);
            }
            return;
        }

    }

    async _initializeRingApi() {
        // Called from _connectRingAPI()
        try {
            const refreshToken = await this.homey.settings.get('ringRefreshToken');

            if (!refreshToken) {
                this.log('_initializeRingApi:        No refresh token available yet');                
                this._authenticated = false;
                const logLine = " Api.js || " + "_initializeRingApi || " + " No refresh token available ";
                this.homey.app.writeLog(logLine);
                return;
            }

            this.log('_initializeRingApi:        Using stored refresh token:', refreshToken.slice(0, 8) + '…'); // show first few chars only

            this.ringApi = new RingApi({
                refreshToken,
                cameraStatusPollingSeconds: cameraStatusInterval,
                locationModePollingSeconds: locationModeInterval,
                controlCenterDisplayName: 'Homey', // Displayed name for the Authorized Device within Control Center in the Ring app
                systemId: this._uniqueid
            });
            // this.log('ringApi',this.ringApi);
            this.log('_initializeRingApi:        ring-client-api connected:', this.ringApi.restClient.baseSessionMetadata);
            this._authenticated = true;
        } catch (error) {
            this.log('_initializeRingApi:        Error connecting ring-client-api', error);
            const logLine = "Api.js || _initializeRingApi || Error: " + error.message;
            this.homey.app.writeLog(logLine);
            throw error; // Let the calling method handle it
        }
    }

    async _subRefreshTokenUpdates() {
        // Called from _connectRingAPI()
        try {
            // Subscribe to receive new refresh token and save it
            this.ringApi.onRefreshTokenUpdated.subscribe(
                async ({ newRefreshToken }) => {
                    this.log('_subRefreshTokenUpdates: New refresh token received:', newRefreshToken.slice(0, 8) + '…');
                    const logLine = "Api.js || _subRefreshTokenUpdates || New refresh token received: " + newRefreshToken.slice(0, 8) + "…";
                    this.homey.app.writeLog(logLine);
                    await this.homey.settings.set('ringRefreshToken', newRefreshToken);
                }
            );
            this.log('_subRefreshTokenUpdates:   Refresh Token updates subscribed');
        } catch (error) {
            this.log('_subRefreshTokenUpdates:   Error onRefreshTokenUpdated', error);
            const logLine = "Api.js || _subRefreshTokenUpdates || Error: " + error.message;
            this.homey.app.writeLog(logLine);
            throw error;
        }
    }

    async _subLocations(locations) {
        // Called from _connectRingAPI()
        this.cameras = [];
        this.chimes = [];
        this.intercoms = [];
        for (const location of locations) {
            //this.log('locationDetails           ',location.locationDetails)
            //this.log('Found location:           ',location.name,' Get devices from the location.')
            this.log('                           Location',location.name,'found, subscribe to events from the devices in that location.')

            this.log('_subLocations:             Subscribing to cameras and doorbells events for location:', location.name);
            await this._getCamerasDoorbells(location);

            this.log('_subLocations:             Subscribing to chime events for location:', location.name);
            await this._getChimes(location);
    
            this.log('_subLocations:             Subscribing to intercom events for location:', location.name);
            await this._getIntercoms(location);
    
            // Subscribe to the mode for the location
            if (location.hasAlarmBaseStation) {
                this.log('_subLocations:             Ring Alarm found at', location.locationDetails.name, 'subscribing to Alarm Mode events');
                // When a location has a Ring Alarm System, subscribe to the Alarm Mode
                await this._subscribeToAlarmMode(location);
                this.log('_subLocations:             Subscribing to Alarm Device events for location:', location.name);
                await this._getAlarmDevices(location);
            } else {
                this.log('_subLocations:             No Ring Alarm found at', location.locationDetails.name);
                // When a location doesn't have a Ring Alarm System, subscribe to the Location Mode
                await this._subscribeToLocationMode(location);
            }
        }
        this.log('_subLocations done.')
    }

    async _subscribeToAlarmMode(location) {
        // Called from _subLocationsModes(locations)
        this.homey.setInterval(() => this._refreshAlarmMode(location.locationDetails.location_id), (alarmModeInterval*1000));
        this.log('_subscribeToAlarmMode:     Alarm Mode subscribed');
    }

    async _getAlarmDevices(location) {
        // Called from _subLocationsModes()
        try {
            this.devices = await location.getDevices()

            // Subscribe to deviceupdates
            for (const device of this.devices) {                
                if (alarmDeviceList.indexOf(device.data.deviceType) >= 0) {
                    this.log(' Alarm device found:      ', device.data.name+":",device.data.deviceType);
                    try {
                        device.onData.subscribe((data) => {
                            // called any time data is updated for this specific device
                            // this.log('ringOnDeviceData:',data);
                            if (this._authenticated) {
                                this.emit('ringOnAlarmData', data);
                            }
                        });
                    } catch (error) {
                        this.log('_getAlarmDevices:          Error subscribing to Alarm Devices');
                        throw error;
                    }
                    // Identify Alarm Security Panel
                    if (device.data.deviceType == RingDeviceType.SecurityPanel) {
                        this.homey.app.alarmSystems.push({
                            zid: device.data.zid,
                            catalogId: device.data.catalogId,
                            location: {
                                id: location.id,
                                name: location.name
                            },
                            mode: null,
                            oldmode: 'none'
                        });
                    }
                }
            }
            if (this.devices.length) {
                this.log('_getAlarmDevices:          Alarm Devices subscribed');
            } else {
                this.log('_getAlarmDevices:          No Alarm Devices found');
            }

            // this._logAllDeviceTypes(this.devices);
            // this._logDeviceInfo(this.devices, RingDeviceType.BaseStation, 'Basestation');
            // this._logDeviceInfo(this.devices, RingDeviceType.Keypad, 'Keypad');
            // this._logDeviceInfo(this.devices, RingDeviceType.SecurityPanel, 'SecurityPanel');
            // this._logDeviceInfo(this.devices, RingDeviceType.SecurityAccessCode, 'SecurityAccessCode');
        }
        catch (error) {
            this.log('_getAlarmDevices:          Error _getAlarmDevices', error);
            throw error;
        }
    }

    async _subscribeToLocationMode(location) {
        // Called from _subLocationsModes(locations)
        try {
            location.onLocationMode.subscribe((locationMode) => {
                // this.log('onLocationMode',location.locationDetails.name, locationMode);
                try {
                    if (this._authenticated) {
                        const locationInfo = {
                            name: location.name,
                            id: location.locationDetails.location_id,
                            mode: locationMode,
                        };
                        this.emit('ringOnLocation', locationInfo);
                    }
                } catch (error) {
                    this.log('_subscribeToLocationMode:  Error:', location.name, error);
                    throw error;
                }
            });
            this.log('_subscribeToLocationMode:  Location Mode subscribed');
        } catch (error) {
            this.log('_subscribeToLocationMode:  Error setting up subscription:', location.name, error);
            throw error;
        }
    }

    async _getCamerasDoorbells(location) {
        // Called from _subLocations()
        try {
            const locationCameras = location.cameras
            for (const camera of locationCameras) {
                // this.log('Api.js camera',camera);                
                camera.onNewNotification.subscribe((notification) => {
                    // this.log("Api.js onNewNotification", notification);
                    try {
                        if (this._authenticated) {
                            this.emit('ringOnNotification', notification);
                        }
                    }
                    catch(e) {
                        this.log('onNewNotification error:', e)
                    }
                })

                camera.onData.subscribe((data) => {
                    // this.log('Api.js camera.onData',data.description);
                    if (this.ringApi && !this.ringApi.restClient.refreshToken) {
                        this.log('onData:                   refreshToken lost');
                        const report = JSON.parse('{"error": "refreshtoken not valid", "error_description": "The refreshtoken is invalid, please reauthenticate."}');
                        this._setAuthenticationStatus(false, report);
                    }
                    try {
                        if (this._authenticated) {
                            this.emit('ringOnData', data);
                        }
                    }
                    catch(e) {
                        this.log('onData', e)
                    }
                })
            }
            if (locationCameras.length) {
                this.cameras.push(...locationCameras);
                this.log('_getCamerasDoorbells:      Cameras and Doorbells subscribed');
            } else {
                this.log('_getCamerasDoorbells:      No cameras of Doorbells found');
            }
        } catch (error) {
            this.log('Api.js _getCamerasDoorbells error:',error);
            throw error;
        }
    }

    async _getChimes(location) {
        // Called from _subLocations()
        try {
            const locationChimes = location.chimes
            if (locationChimes.length) {
                this.chimes.push(...locationChimes);
                this.log('_getChimes:                Chimes subscribed');
            } else {
                this.log('_getChimes:                No chimes found');
            }
        }
        catch (error) {
            this.log('_getChimes:                Error:', location.name, error);
            throw error;
        }
    }

    async _getIntercoms(location) {
        // Called from _connectRingAPI()
        try {
            const locationIntercoms = location.intercoms;
            for (const intercom of locationIntercoms) {
                // this.log('Api.js intercom',intercom);
                intercom.onDing.subscribe(() => {
                    //this.log('Api.js intercom.onDing', intercom);
                    try {
                        if (this._authenticated) {
                            this.emit('ringOnDing', intercom);
                        }
                    } catch (error) {
                        this.log('Api.js intercom.onDing', error);
                        throw error;
                    }
                });
                intercom.onData.subscribe((data) => {
                    // this.log('Api.js intercom.onData',data);
                    if (this.ringApi && !this.ringApi.restClient.refreshToken) {
                        this.log('onData:                   refreshToken lost');
                        const report = JSON.parse(
                            '{"error": "refreshtoken not valid", "error_description": "The refreshtoken is invalid, please reauthenticate."}'
                        );
                        this._setAuthenticationStatus(false, report);
                    }
                    try {
                        if (this._authenticated) {
                            this.emit('ringOnData', data);
                        }
                    } catch (error) {
                        this.log('Api.js intercom.onData', error);
                        throw error;
                    }
                });
            }
            if (locationIntercoms.length) {
                this.intercoms.push(...locationIntercoms);
                this.log('_getIntercoms:             Intercoms subscribed');
            } else {
                this.log('_getIntercoms:             No intercoms found');
            }
        }
        catch (error) {
            this.log('_getIntercoms:             Error:', location.name, error);
            throw error;
        }
    }

    // -------------- Debugging methods for integrating Ring Alarm System

    // This method retrieves the Device Type from all Ring Alarm Devices actually connected.
    // Use this to find the device type of a newly connected device
    _logAllDeviceTypes(_devices) { 
        for (const device of _devices) {
            this.log('device.data.deviceType:',device.data.deviceType)
        }
    }

    // This method retrieves all information of a device and subscribes to changes
    _logDeviceInfo(_devices, _deviceType, _description) {
        const device = _devices.find(
            (device) => device.data.deviceType === _deviceType
        )

        // All devices properties
        this.log(_description+':',device)
        
        // baseStation data
        device.onData.subscribe((data) => {
            // called any time data is updated for this specific device
            this.log(_description+':',data);
        })
    }

    // -------------- Debugging methods for integrating Ring Alarm System

    _disconnectRingAPI ( ) {
        //this.log('_disconnectRingAPI');
        try {
            this.ringApi.disconnect();
            this.ringApi = null;
        }
        catch(e) {
            this.log('_disconnectRingAPI:',e)
        }
    }

    // Polling the Alarm Mode when the location has a Ring Alarm System
   async _refreshAlarmMode (locationId) {
        // this.log('_refreshAlarmMode',locationId);
        if (!this._authenticated) {
            return;
        }

        //this.locations.forEach(async (location) => {
        for (const location of this.locations) {
            if (location.locationDetails.location_id == locationId) {

                const mode = await location.getAlarmMode(); // no longer working :(
                const locationModes = { none: 'disarmed', some: 'home', all: 'away' };

                const locationInfo = {
                    name: location.locationDetails.name,
                    id: locationId,
                    mode: locationModes[mode]
                }
                this.emit('ringOnLocation', locationInfo);
            }
        }

    }

    _getGrantData (auth) {
        return {
            grant_type: "password",
            username: auth.user,
            password: auth.pass
        };
    }

    // Use this method to trigger the MFA message to use
    // Pass the auth object containing the user and pass
    _https_auth_cred(auth) {
        this.log('_https_auth_cred');

        return new Promise(async (resolve, reject) => {
            if (!auth) return reject(new Error('invalid_credentials'));

            const grantData = this._getGrantData(auth);

            const postdata = JSON.stringify({
                client_id: "ring_official_android",
                scope: "client",
                ...grantData
            });

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), refreshTimeout);

            const url = 'https://oauth.ring.com/oauth/token';

            const options = {
                method: 'POST',
                headers: {
                    'User-Agent': 'android:com.ringapp',
                    '2fa-support': 'true',
                    'content-type': 'application/json',
                    'content-length': postdata.length
                },
                body: postdata,
                signal: controller.signal
            };

            try {
                const response = await fetch(url, options);
                clearTimeout(timeout);

                const text = await response.text();
                const data = text.replace(/(\r\n|\n|\r)/gm, "");
                let result = {};
                let report = {};

                if (response.status >= 400) {
                    if (response.status === 412) {
                        this._authenticated = false;
                        this.log('_https_auth_cred : require mfa code : ', response.status);
                        try {
                            report = JSON.parse(`{"error": "invalid_response ${response.status}", "error_description": "${data}"}`);
                        } catch {
                            report = { error: `invalid_response ${response.status}`, error_description: String(response.status) };
                        }
                        this._setAuthenticationStatus(false, report);
                    } else {
                        this._authenticated = false;
                        this.log('_https_auth_cred : authentication error : ', response.status);
                        try {
                            report = JSON.parse(`{"error": "invalid_response ${response.status}", "error_description": "${data}"}`);
                        } catch {
                            report = { error: `invalid_response ${response.status}`, error_description: String(response.status) };
                        }
                        this._setAuthenticationStatus(false, report);
                        return reject(new Error(`invalid_authentication ${response.status} ${data}`));
                    }
                } else {
                    try {
                        result = JSON.parse(data);
                        this._setAuthenticationStatus(true, null);
                    } catch (parseErr) {
                        return reject(parseErr);
                    }
                }

                resolve(result);

            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    // Use this methode to pass the MFA code along with the request
    _https_auth_code(auth, code) {
        this.log('_https_auth_code');

        return new Promise(async (resolve, reject) => {
            if (!auth) return reject(new Error('invalid_credentials'));

            const grantData = this._getGrantData(auth);

            const postdata = JSON.stringify({
                client_id: "ring_official_android",
                scope: "client",
                ...grantData
            });

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), refreshTimeout);

            const url = 'https://oauth.ring.com/oauth/token';

            const options = {
                method: 'POST',
                headers: {
                    'User-Agent': 'android:com.ringapp',
                    '2fa-support': 'true',
                    '2fa-code': code || '',
                    'content-type': 'application/json',
                    'content-length': postdata.length
                },
                body: postdata,
                signal: controller.signal
            };

            try {
                const response = await fetch(url, options);
                clearTimeout(timeout);

                const text = await response.text();
                const data = text.replace(/(\r\n|\n|\r)/gm, "");
                let result = {};
                let report = {};

                if (response.status >= 400) {
                    this._authenticated = false;
                    this.log('_https_auth_code : invalid_authentication : ', response.status);

                    try {
                        report = JSON.parse(`{"error": "invalid_response ${response.status}", "error_description": "${data}"}`);
                    } catch {
                        report = { error: `invalid_response ${response.status}`, error_description: String(response.status) };
                    }

                    this._setAuthenticationStatus(false, report);
                    return reject(new Error(`invalid_authentication ${response.status} ${data}`));
                }

                try {
                    result = JSON.parse(data);
                    this.log('_https_auth_code: retrieved the refresh and access token');
                    this.homey.settings.set('ringRefreshToken', result.refresh_token);
                    this._authenticated = true;
                    this._setAuthenticationStatus(true, null);
                } catch (parseErr) {
                    return reject(parseErr);
                }

                resolve(result);

            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    _onSetSettings (name) {
        //this.log('_onSetSettings', name, this.homey.settings.get(name));

        if (name === 'isRevoked') {
            if (this.homey.settings.get(name)) {
                this.homey.settings.set('ringAccesstoken', null);
                //this.homey.settings.set('ringBearer', null);
                this.homey.settings.set('ringRefreshToken', null);
                this.homey.settings.set('authenticationStatus', 'Authentication Revoked');
                this.homey.settings.set('authenticationError', "The authentication has been revoked.");

                this._authenticated = false;
                this.log('_onSetSettings: Authentication revoked from settings');
                let logLine = "Api.js || " + "_onSetSettings || " + " Authentication revoked from settings ";
                this.homey.app.writeLog(logLine);
                const report = JSON.parse('{"error": "Authentication Revoked", "error_description": "The authentication has been revoked."}');

                this._setAuthenticationStatus(false, report);
            }
        }

        if (name === 'isDebugEnabled') {
            const isDebugEnabled = this.homey.settings.get(name)
            this.homey.settings.set('isDebugEnabled', isDebugEnabled);
            this.homey.app.isDebugEnabled = isDebugEnabled;
            if (!isDebugEnabled) {
                this.homey.settings.set('debugLog', '' );
            } else {
                let logLine = 'Debug logging is enabled from device settings.'
                this.homey.app.writeLog(logLine);
            }
        }

    }

    async _verifyAuthentication() {
        this.log('_verifyAuthentication') // (step 1 in verification sequence)
    
        if (this._refreshToken) {
            // If there is a refresh token stored, try to connect to the Ring API
            await this._connectRingAPI();
        }
    
        if (this._authenticated) {
            this._setAuthenticationStatus(true, null);
            return true; // Resolve with true
        } else {
            const report = JSON.parse('{"error": "Unauthenticated", "error_description": "The app is not authenticated at Ring."}');
            this._setAuthenticationStatus(false, report);
            throw new Error('authenticated_failed'); // Reject with an error
        }
    }

    // This function sets the authentication when it changes from one state to another
    // It will log the change and sent out events.
    // When unauthenticated by an api error it starts a recurring attempt to authenticate
    _setAuthenticationStatus (status, report) {
        //this.log('_setAuthenticationStatus: ', status);
        //this.log('this._authenticated:      ',this._authenticated)

        if (this._previousAuthenticated != this._authenticated) {
            if (this._authenticated) {
                if (!this.NoAuthStatLogTimeout) {
                    this.log('_setAuthenticationStatus:  Successfully Authenticated');
                    let logLine = "Api.js || " + "_setAuthenticationStatus || " + " Successfully Authenticated ";
                    this.homey.app.writeLog(logLine);
                } else {
                    //this.log('_setAuthenticationStatus: Successfully Authenticated, this.NoAuthStatLogTimeout != false');
                }
                clearTimeout(this.NoAuthStatLogTimeout);
                this.NoAuthStatLogTimeout = null;
                clearInterval(this._verifyInterval);

                // connect ring-client-api
                this._connectRingAPI();

                // This event is emitted Homey wide, other apps can act on this
                // The settingspage uses this event to show changes in the authentication state
                this.homey.api.realtime('com.ring.status', { state: 'authenticated'});
                // This event is emitted inside the app
                // The devices use this event to set them available and unavailable
                this.homey.emit('authenticationChanged', 'authenticated');
                // When authenticated again stop the recurring attempt to authenticate
                this.homey.settings.set('isRevoked', false);
            } else {
                this.NoAuthStatLogTimeout = setTimeout(async () => {
                    await delay(50);
                    this.homey.api.realtime('com.ring.status', { state: 'unauthenticated'});
                    this.homey.emit('authenticationChanged', 'unauthenticated');

                    let logLine = "Api.js || " + "_setAuthenticationStatus || " + " Unauthenticated ";
                    this.homey.app.writeLog(logLine);
                    // disconnect ring-client-api
                    this._disconnectRingAPI();

                }, 1000);
            }
            this._previousAuthenticated = this._authenticated;
        }

        if (status) {
            if ( this.homey.settings.get('authenticationStatus') != 'Authenticated' ) {
                this.homey.settings.set('authenticationStatus', 'Authenticated');
                this.homey.settings.set('authenticationError', '');
            }
        } else {
            if (this.homey.settings.get('authenticationStatus') != report.error) {
                this.homey.settings.set('authenticationStatus', report.error);
                this.homey.settings.set('authenticationError', report.error_description);
            }
        }
    }

    async getDevices() {
        try {
            return await this.ringApi.fetchRingDevices();
        } catch (error) {
            this.error('getDevices failed:', error);
            throw error;
        }
    }

    async getAlarmDevices() {
        try {
            const devices = [];

console.log('this.locations::::',this.locations.length)

            for (const location of this.locations) {
console.log('location::::',location.locationDetails.name)                
                const result = await location.getDevices();
console.log('devices::::',result)                
                devices.push(...result);
            }

            return devices;
        } catch (error) {
            this.error('getAlarmDevices failed:', error);
            throw error;
        }
    }

    async ringChime (device_data, sound) {
        //this.log('ringChime', device_data);
        try {
            const chime = this.chimes.find(c => c.id === device_data.id);
            if (!chime) {
                throw new Error(`Chime with id ${device_data.id} not found`);
            }

            const soundToPlay = sound === 'ring' ? 'ding' : 'motion';
            await chime.playSound(soundToPlay);
            return true;
        } catch (error) {
            this.error('Api.js ringChime:', error);
            throw error;
        }
    }

    async snoozeChime(device_data, duration) {
        //this.log('snoozeChime', device_data, duration);
        try {
            const chime = this.chimes.find(c => c.id === device_data.id);
            if (!chime) {
                throw new Error(`Chime with id ${device_data.id} not found`);
            }

            chime.snooze(duration * 60); // duration in minutes → seconds
            return true;
        } catch (error) {
            this.error('Api.js snoozeChime:', error);
            throw error;
        }
    }

    async unsnoozeChime(device_data) {
        //this.log('unsnoozeChime', device_data);
        try {
            const chime = this.chimes.find(c => c.id === device_data.id);
            if (!chime) {
                throw new Error(`Chime with id ${device_data.id} not found`);
            }

            chime.clearSnooze();
            return true;
        } catch (error) {
            this.error('Api.js unsnoozeChime:', error);
            throw error;
        }        
    }

    async lightOn(device_data) {
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) {
                throw new Error(`Camera with id ${device_data.id} not found`);
            }

            const result = await camera.setLight(true);
            return result;
        } catch (error) {
            this.log('Error in lightOn:', error);
            throw error;
        }
    }

    async lightOff(device_data) {
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) {
                throw new Error(`Camera with id ${device_data.id} not found`);
            }

            const result = await camera.setLight(false);
            return result;
        } catch (error) {
            this.log('Error in lightOff:', error);
            throw error;
        }
    }

    async sirenOn(device_data) {
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) {
                throw new Error(`Camera with id ${device_data.id} not found`);
            }

            const result = await camera.setSiren(true);
            return result;
        } catch (error) {
            this.log('Error in sirenOn:', error);
            throw error;
        }
    }

    async sirenOff(device_data) {
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) {
                throw new Error(`Camera with id ${device_data.id} not found`);
            }

            const result = await camera.setSiren(false);
            return result;
        } catch (error) {
            this.log('Error in sirenOff:', error);
            throw error;
        }
    }

    async unlock(device_data) {
        try {
            const intercom = this.intercoms.find(i => i.initialData.id === device_data.id);
            if (!intercom) {
                throw new Error(`Intercom with id ${device_data.id} not found`);
            }

            const result = await intercom.unlock();

            return result.result.code === 0;
        } catch (error) {
            this.log('Error in unlock:', error);
            throw error;
        }
    }

    // This function will grab an image
    // This is called from the handler inside the image.setStream() in a device(.js)
    async grabImage(device_data) {
        // this.log('grabImage', 'Called for', device_data);
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) {
                throw new Error(`Api.js grabImage: Camera not found for device ID: ${device_data.id}`);
            }

            const result = await camera.getSnapshot();
            return result;
        } catch (error) {
            this.log('Api.js grabImage', error);
            throw error;
        }
    }

    // This function will start a video stream
    // This is called from the handler inside the this.device.cameraVideo.registerOfferListener in a device(.js)
    async grabVideo(device_data, offerSdp) {
        this.log('grabVideo', 'Called for', device_data.id);
        try {
            const camera = this.cameras.find(c => c.initialData.id === device_data.id);
            if (!camera) throw new Error('Camera not found');

            this.log('Api.js grabVideo Camera is mains powered:', this._isCameraMainsPowered(camera))

// uncomment next line to get all camera data information logged.
// this.log(camera.data);

            if (!this._isCameraMainsPowered(camera)) {
                throw 'Live video not supported on battery operated cameras';
            }

            const session = camera.createSimpleWebRtcSession();
            let answerSdp = await session.start(offerSdp);

            // fix the answerSdp so Homey accepts it
            answerSdp = this._reorderAndFixSdp(offerSdp, answerSdp);

            return answerSdp;
        } catch (error) {
            this.log('Api.js grabVideo', error);
            throw error;
        }
    }

    _isCameraMainsPowered(camera) {
        const data = camera?.data || {};
        const health = data.health || {};
        const kind = (data.kind || '').toLowerCase();

        // 1) Explicit AC/mains indicators (most authoritative)
        if (health.ac_power === 1) return true;
        if (health.external_connection === true) return true;
        if (data.power_mode === 'wired') return true;

        // 2) Transformer info (doorbells)
        if (typeof health.transformer_voltage === 'number' && health.transformer_voltage > 16) return true;
        if (typeof health.transformer_status === 'string' && health.transformer_status.toLowerCase() !== 'none') return true;

        // 3) ext_power_state (some cameras)
        if (data.ext_power_state !== undefined && data.ext_power_state !== null) {
            const n = Number(data.ext_power_state);
            if (!Number.isNaN(n) && n > 0) return true;
        }

        // 4) Battery-only devices
        if (
            (camera.batteryLife !== undefined || camera.batteryStatus !== undefined || data.battery_percentage !== undefined)
            && health.ac_power !== 1 && health.external_connection !== true
        ) {
            return false;
        }

        // 5) Doorbells: fallback for older models
        if (
            kind.startsWith('lpd_') ||
            (kind.includes('doorbell') &&
            !kind.includes('battery') &&
            !kind.includes('peephole'))
        ) {
            return true;
        }

        // 6) Infer from kind as a last resort
        if (kind.includes('battery')) return false;
        if (kind.includes('wired') || kind.includes('plug_in')) return true;

        // Default to false if unknown
        return false;
    }

    _reorderAndFixSdp(offerSdp, answerSdp) {
        // normalize line endings
        offerSdp = offerSdp.replace(/\r\n/g, '\n');
        answerSdp = answerSdp.replace(/\r\n/g, '\n');

        // split into header and media blocks
        const splitMedia = s => {
            const parts = s.split(/\n(?=m=)/); // keep "m=" at start of blocks
            return {
            header: parts[0].trim(),
            blocks: parts.slice(1).map(b => b.trim())
            };
        };

        const offer = splitMedia(offerSdp);
        const answer = splitMedia(answerSdp);

        // map answer blocks by mid
        const mapByMid = (blocks) => {
            const map = {};
            for (const b of blocks) {
            const m = b.match(/\na=mid:([^\s\r\n]+)/) || b.match(/^a=mid:([^\s\r\n]+)/m);
            const mid = m ? m[1] : null;
            if (mid) map[mid] = b;
            else {
                // try to extract mid from m= line index if no a=mid present
                const midFromMline = b.match(/^m=\w+\s+\d+\s+[^\s]+\s.*$/m);
                // skip if unknown
            }
            }
            return map;
        };

        const answerMap = mapByMid(answer.blocks);
        const offerMap = mapByMid(offer.blocks);

        // get offer order of mids
        const offerMids = [];
        for (const b of offer.blocks) {
            const m = b.match(/\na=mid:([^\s\r\n]+)/) || b.match(/^a=mid:([^\s\r\n]+)/m);
            if (m) offerMids.push(m[1]);
        }

        // helper to detect offer direction for a given mid
        const getOfferDirection = (mid) => {
            const block = offerMap[mid];
            if (!block) return null;
            if (/\brecvonly\b/.test(block)) return 'recvonly';
            if (/\bsendonly\b/.test(block)) return 'sendonly';
            if (/\bsendrecv\b/.test(block)) return 'sendrecv';
            return null;
        };

        // synthesize a minimal application block from offer if answer lacks it
        const synthesizeApplicationBlock = (offerBlock, mid) => {
            // try to extract sctp-port from offer block
            const sctpMatch = (offerBlock && offerBlock.match(/a=sctp-port:(\d+)/));
            const sctpPort = sctpMatch ? sctpMatch[1] : '5000';
            return [
            `m=application 0 UDP/DTLS/SCTP webrtc-datachannel`,
            `c=IN IP4 0.0.0.0`,
            `a=mid:${mid}`,
            `a=inactive`,
            `a=sctp-port:${sctpPort}`,
            `a=max-message-size:262144`
            ].join('\n');
        };

        // build reordered blocks in offer order
        const reordered = [];
        for (const mid of offerMids) {
            let block = answerMap[mid];

            if (block) {
            // fix audio direction: if offer had recvonly -> answer must be sendonly
            const offerDir = getOfferDirection(mid);
            if (offerDir === 'recvonly') {
                // only change if answer does not have sendonly already
                if (!/^\s*a=sendonly\b/m.test(block) && !/^\s*a=sendrecv\b/m.test(block)) {
                // nothing
                }
                // replace sendrecv with sendonly, or ensure sendonly present
                block = block.replace(/\b(sendrecv|recvonly|sendonly)\b/, 'sendonly');
            }
            // ensure end-of-candidates present after candidates in each block (if candidates exist)
            if (/^a=candidate:/m.test(block) && !/a=end-of-candidates/m.test(block)) {
                // add end-of-candidates before first rtpmap or end of block
                block = block.replace(/(\n(?=(a=rtpmap|a=rtcp-fb|a=fmtp|a=ssrc|$)))/m, '\na=end-of-candidates$1');
            }
            } else {
            // missing in answer: synthesize minimal (mostly for application m-line)
            const offerBlock = offerMap[mid];
            if (offerBlock && /^m=application\b/m.test(offerBlock)) {
                block = synthesizeApplicationBlock(offerBlock, mid);
            } else if (offerBlock) {
                // synthesize a minimal media m-line with inactive
                const mline = offerBlock.split('\n')[0]; // m=... line from offer
                const mediaType = mline.split(' ')[0].replace(/^m=/, '');
                block = [
                `${mline.split(' ')[0]} 0 ${mline.split(' ')[2]} ${mline.split(' ').slice(3).join(' ')}`, // keep payload types
                `c=IN IP4 0.0.0.0`,
                `a=mid:${mid}`,
                `a=inactive`
                ].join('\n');
            } else {
                // fallback: blank inactive mid
                block = `m=application 0 UDP/DTLS/SCTP webrtc-datachannel\nc=IN IP4 0.0.0.0\na=mid:${mid}\na=inactive`;
            }
            }

            // ensure block lines are trimmed and appended
            reordered.push(block.trim());
        }

        // make bundle group match offer
        const offerBundle = (offer.header.match(/^a=group:BUNDLE (.+)$/m) || [])[1] || offerMids.join(' ');
        const headerLines = offer.header.split('\n').filter(Boolean).map(l => l.trim());
        // replace or add a=group:BUNDLE line in answer header
        let answerHeader = answer.header;
        if (/^a=group:BUNDLE /m.test(answerHeader)) {
            answerHeader = answerHeader.replace(/^a=group:BUNDLE .*/m, `a=group:BUNDLE ${offerBundle}`);
        } else {
            answerHeader = `${answerHeader}\n a=group:BUNDLE ${offerBundle}`;
        }

        // join everything with CRLF as SDP expects
        const final = [answerHeader, ...reordered].join('\r\n') + '\r\n';
        return final;
    }

    async enableMotion(device_data) {
        for (const camera of this.cameras) {
            if (camera.initialData.id === device_data.id) {
                try {
                    const newSetting = this.getMotionSettings(true);
                    const result = await camera.setDeviceSettings(newSetting);
                    await camera.subscribeToMotionEvents();
                    return result;
                } catch (error) {
                    this.error('Api.js enableMotion:', error);
                    throw error;
                }
            }
        }

        throw new Error(`Camera with id ${device_data.id} not found`);
    }

    async disableMotion(device_data) {
        for (const camera of this.cameras) {
            if (camera.initialData.id === device_data.id) {
                try {
                    const newSetting = this.getMotionSettings(false);
                    const result = await camera.setDeviceSettings(newSetting);
                    await camera.unsubscribeFromMotionEvents();
                    return result;
                } catch (error) {
                    this.error('Api.js disableMotion:', error);
                    throw error;
                }
            }
        }

        throw new Error(`Camera with id ${device_data.id} not found`);
    }


    // called by the enableMotion() and disableMotion()
    getMotionSettings (enabled) {
        return {
            motion_settings: {
                motion_detection_enabled: enabled
            }
        };
    }

    // this function is called from the autocomplete in flowcards
    userLocations() {
        //this.log(`userLocations: Send request to retrieve all user locations in Ring`);
        return new Promise((resolve, reject) => {
            // Check if this.locations is defined and is an array
            if (Array.isArray(this.locations)) {
                const locations = [];
                for (const location of this.locations) {
                    //console.log(location.locationDetails.name);
                    locations.push({
                        name: location.locationDetails.name,
                        id: location.locationDetails.location_id,
                        mode: 'unset'
                    });
                }
                resolve(locations);
            } else {
                // Handle the case where this.locations is undefined or not an array
                reject(new Error('Locations data is not available'));
            }
        });

    }

    async setLocationMode(locationId, mode) {
        try {
            const location = this.locations.find(
                loc => loc.locationDetails.location_id === locationId
            );

            if (!location) {
                throw new Error(`Location with ID ${locationId} not found`);
            }

            const alarmModes = { disarmed: 'none', home: 'some', away: 'all' };

            const result = location.hasAlarmBaseStation
                ? await location.setAlarmMode(alarmModes[mode])
                : await location.setLocationMode(mode);

            return result;

        } catch (error) {
            this.error('setLocationMode failed:', error);
            throw error;
        }
    }


    /*
    setLocationMode(locationId,  mode) {
        //this.log(`setLocationMode: Send request to switch the location to a new mode`, mode);
        return new Promise((resolve, reject) => {
          this._setLocationMode(locationId,  mode, (error, result) => {
            if (error) {
              this.log(`setLocationMode error:`, error);
              return reject(error);
            }
            return resolve(result);
          })
        });
    }
    */

    mapLocationMode (mode) {
        return {
           mode: mode
        };
    }

}

module.exports = Api;
