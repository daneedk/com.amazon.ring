const Homey = require('homey');
const https = require('https');
//const crypto = require('crypto');
//const events = require('events');
//const stringify = require('querystring').stringify;

// const { RingApi } = require('../ring-client-api')                // 14.0.0 18-06-2025 This version works on Homey Pro Early 2023 and nweer
// const { RingDeviceType } = require('../ring-client-api');        // 14.0.0 18-06-2025 This version works on Homey Pro Early 2023 and nweer
// const { RingApi } = require('../ring-client-api13.1.0')          // 13.1.0 18-06-2025 This version works on older Homey (Pro)
// const { RingDeviceType } = require('../ring-client-api13.1.0');  // 13.1.0 18-06-2025 This version works on older Homey (Pro)

//const { RingApi, RingDeviceType } = require('./loadRingApi')();

const { ringClient, supportsModern } = require('./loadRingApi')();
const { RingApi, RingDeviceType } = ringClient;

const refreshTimeout       = 5000;
const cameraStatusInterval = 5;
const locationModeInterval = 5;
const alarmModeInterval    = 5;
const allowedModes         = ["home", "away", "disarmed"];
// Devicetypes for which data is emited
//                            Contact           Motion           Keypad             Alarm             Basestation
// const alarmDeviceList   = [ 'sensor.contact', 'sensor.motion', 'security-keypad', 'security-panel', 'hub.redsky' ];
const alarmDeviceList      = [ 'sensor.contact', 'sensor.motion', 'security-keypad', 'security-panel'];

const parse = require('url').parse;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Api extends Homey.SimpleClass {

    log() {
        this.homey.log.bind(this, '[Api]').apply(this, arguments);
    }

    constructor(homey) {
        super();

        this.homey = homey;
        this._refreshToken = null;
        this._uniqueid = null;
        this._authenticated = false;
        this._previousAuthenticated = null;
        this._authenticating = false;
        this._apiversion = 11;
        this.supportsModern = supportsModern;

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
                            this.log('_verifyAuthentication:     Failed:',error.toString())
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
            return;
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
            this._subLocations(this.locations);
        }
        catch(error) {
            this.log('_connectRingAPI locations error',error.toString());
            this.ringApi = null;
            if ( error.toString().includes("Error: Refresh token is not valid.")) {
                this._authenticated = false;
                const report = JSON.parse('{"error": "refreshtoken not valid", "error_description": "The refreshtoken is invalid, please reauthenticate."}');
                this._setAuthenticationStatus(false, report);
            }
            return;
        }

        // Step 4
        // Get all cameras
        this.log('_connectRingAPI:           Subscribing to camera events for all locations');
        await this._getCameras(this.locations)

    }

    async _initializeRingApi() {
        // Called from _connectRingAPI()
        try {
            this.ringApi = new RingApi({
                refreshToken: await this.homey.settings.get('ringRefreshToken'),
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
            throw error; // Let the calling method handle it
        }
    }

    async _subRefreshTokenUpdates() {
        // Called from _connectRingAPI()
        try {
            // Subscribe to receive new refresh token and save it
            this.ringApi.onRefreshTokenUpdated.subscribe(
                async ({ newRefreshToken, oldRefreshToken }) => {
                    if (oldRefreshToken) {
                        // this.log('New refresh token received and saved to settings');
                        await this.homey.settings.set('ringRefreshToken', newRefreshToken);
                    }
                }
            );
            this.log('_subRefreshTokenUpdates:   Refresh Token updates subscribed');
        } catch (error) {
            this.log('_subRefreshTokenUpdates:   Error onRefreshTokenUpdated', error);
        }
    }

    async _subLocations(locations) {
        // Called from _connectRingAPI()
        for (const location of locations) {
            // this.log('locationDetails           ',location.locationDetails)

            this.log('_subLocations:             Subscribing to chime events for location:', location.name);
            await this._getChimes(location);
    
            this.log('_subLocations:             Subscribing to intercom events for location:', location.name);
            await this._getIntercoms(location);

            /*
            location.onMessage.subscribe((notification) => { 
                this.log('location.onMessage',notification)
            })
            */
    
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
            //this.devices.forEach(async device => {
            for (const device of this.devices) {                
                if (alarmDeviceList.indexOf(device.data.deviceType) >= 0) {
                    this.log('Alarm device found:       ', device.data.name+":",device.data.deviceType);
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
                    }
                    // Identify Alarm Security Panel
                    if ( device.data.deviceType == RingDeviceType.SecurityPanel ) {
                        this.homey.app.alarmSystem.catalogId = device.data.catalogId;
                        this.homey.app.alarmSystem.location.id = location.id;
                        this.homey.app.alarmSystem.location.name = location.name;
                    }
                }
            }//)
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
                }
            });
            this.log('_subscribeToLocationMode:  Location Mode subscribed');
        } catch (error) {
            this.log('_subscribeToLocationMode:  Error setting up subscription:', location.name, error);
        }
    }

    async _getChimes(location) {
        // Called from _connectRingAPI()
        try {
            this.chimes = location.chimes
             for (const chime of this.chimes) {
                chime.onData.subscribe((data) => { 
                    // this.log('chime.onData:',data.alerts.connection) // online/offline
                    if ( data.alerts.connection === "online" ) {
                        // todo connection restored, set device available
                    } else {
                        // todo connection lost, set device unavailable
                    }
                })
            }
            if (this.chimes.length) {
                this.log('_getChimes:                Chimes subscribed');
            } else {
                this.log('_getChimes:                No chimes found');
            }
        }
        catch (error) {
            this.log('_getChimes:                Error:', location.name, error);
        }
    }

    async _getIntercoms(location) {
        // Called from _connectRingAPI()
        try {
            this.intercoms = location.intercoms;
            //this.intercoms.forEach(async (intercom) => {
            for (const intercom of this.intercoms) {
                // this.log('Api.js intercom',intercom);
                intercom.onDing.subscribe(() => {
                    //this.log('Api.js intercom.onDing', intercom);
                    try {
                        if (this._authenticated) {
                            this.emit('ringOnDing', intercom);
                        }
                    } catch (e) {
                        this.log('Api.js intercom.onDing', e);
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
                    } catch (e) {
                        this.log('Api.js intercom.onData', e);
                    }
                });
            }
            if (this.intercoms.length) {
                this.log('_getIntercoms:             Intercoms subscribed');
            } else {
                this.log('_getIntercoms:             No intercoms found');
            }
        }
        catch (error) {
            this.log('_getIntercoms:             Error:', location.name, error);
        }
    }

    async _getCameras(locations) {
        // Called from _connectRingAPI()
        try {
            // Get all cameras and subscribe to Ring and Motion events, next subscribe on camera information (interval on cameraStatusInterval)
            this.cameras = await this.ringApi.getCameras();
            //this.cameras.forEach(async camera => {
            for (const camera of this.cameras) {    
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
            if (this.cameras.length) {
                this.log('_getCameras:               Cameras subscribed');
            } else {
                this.log('_getCameras:               No cameras found');
            }
            
        }
        catch(error) {
            this.log('_getCameras cameras error',error.toString());
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
        if (!auth ) {
            /*
            return {
                grant_type: "refresh_token",
                refresh_token: this.homey.settings.get('ringRefreshToken')
            }
            */
        } else {
            return {
                grant_type: "password",
                username: auth.user,
                password: auth.pass
            }
        }
    }

    //Use this method to trigger the MFA message to use
    //Pass the auth object containing the user and pass
    _https_auth_cred (auth, callback) {
        this.log('_https_auth_cred');
        if (auth === null || auth === undefined) {
            return callback(new Error('invalid_credentials'));
        }

        const grantData = this._getGrantData(auth)

        let postdata = JSON.stringify({
            client_id: "ring_official_android",
            scope: "client",
            ...grantData
            //grant_type: "password",
            //username: auth.user,
            //password: auth.pass
        });

        let timeout = setTimeout(() => {
            request.destroy();
        }, refreshTimeout);

        const url = parse('https://oauth.ring.com/oauth/token');
        url.method = 'POST';
        url.headers = {
            'User-Agent': 'android:com.ringapp',
            //hardware_id: this._uniqueid,
            '2fa-support': 'true',
            'content-type': 'application/json',
            'content-length': postdata.length
        };

        let request = https.request(url, (response) => {
            let data = '';

            response.on('data', (chunk) => {
                data += chunk;
            });

            response.on('end', () => {
                let error = null;
                let result = {};
                let report = {};

                if (response.statusCode >= 400) {
                    if(response.statusCode==412)
                    {
                        this._authenticated = false;
                        data = data.replace(/(\r\n|\n|\r)/gm, "");
                        this.log('_https_auth_cred : require mfa code : ', response.statusCode);
                        try {
                            report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + data + '"}');
                        } catch (e) {
                            report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + response.statusCode + '"}');
                        }
                        this._setAuthenticationStatus(false, report);

                    } else {
                        this._authenticated = false;
                        data = data.replace(/(\r\n|\n|\r)/gm, "");
                        this.log('_https_auth_cred : authentication error : ', response.statusCode);
                        error = new Error('invalid_authentication ' + response.statusCode + ' ' + data);
                        try {
                            report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + data + '"}');
                        } catch (e) {
                            report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + response.statusCode + '"}');
                        }
                        this._setAuthenticationStatus(false, report);

                    }
                } else {
                    try {
                        result = JSON.parse(data);
                        this._setAuthenticationStatus(true, null);

                    } catch (e) {
                        error = e;
                    }
                }

                clearTimeout(timeout);
                callback(error, result);
            });

            response.on('error', (error) => {
                clearTimeout(timeout);
                callback(error);
            });
        });

        request.on('error', (error) => {
            clearTimeout(timeout);
            callback(error);
        });

        request.write(postdata);

        request.end();

    }

    //Use this methode to pass the MFA code along with the request
    _https_auth_code (auth, code, callback) {
        this.log('_https_auth_code');
        if (auth === null || auth === undefined) {
            return callback(new Error('invalid_credentials'));
        }

        const grantData = this._getGrantData(auth)

        let postdata = JSON.stringify({
            client_id: "ring_official_android",
            scope: "client",
            ...grantData
            //grant_type: "password",
            //username: auth.user,
            //password: auth.pass
        });

        let timeout = setTimeout(() => {
            request.destroy();
        }, refreshTimeout);

        const url = parse('https://oauth.ring.com/oauth/token');
        url.method = 'POST';
        url.headers = {
            'User-Agent': 'android:com.ringapp',
            //hardware_id: this._uniqueid,
            '2fa-support': 'true',
            '2fa-code': code || '',
            'content-type': 'application/json',
            'content-length': postdata.length
        };

        let request = https.request(url, (response) => {
            let data = '';

            response.on('data', (chunk) => {
                data += chunk;
            });

            response.on('end', () => {
                let error = null;
                let result = {};
                let report = {};

                if (response.statusCode >= 400) {
                    this._authenticated = false;
                    data = data.replace(/(\r\n|\n|\r)/gm, "");
                    this.log('_https_auth_code : invalid_authentication : ', response.statusCode);
                    error = new Error('invalid_authentication ' + response.statusCode + ' ' + data);
                    try {
                        report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + data + '"}');
                    } catch (e) {
                        report = JSON.parse('{"error": "invalid_response ' + response.statusCode + '", "error_description": "' + response.statusCode + '"}');
                    }
                    this._setAuthenticationStatus(false, report);

                } else {
                    try {
                        result = JSON.parse(data);
                        this.log('_https_auth_code: retrieved the refresh and access token')
                        this.homey.settings.set('ringRefreshToken', result.refresh_token);
                            //this._bearer = result.access_token;
                            //this.homey.settings.set('ringBearer', result.access_token);
                        this._authenticated = true;
                        this._setAuthenticationStatus(true, null);
                    } catch (e) {
                        error = e;
                    }
                }

                clearTimeout(timeout);
                callback(error, result);
            });

            response.on('error', (error) => {
                clearTimeout(timeout);
                callback(error);
            });
        });

        request.on('error', (error) => {
            clearTimeout(timeout);
            callback(error);
        });

        request.write(postdata);

        request.end();
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
                //let logLine = " Api.js || " + "_onSetSettings || " + " Authentication revoked from settings ";
                //this.homey.app.writeLog(logLine);
                let report = JSON.parse('{"error": "Authentication Revoked", "error_description": "The authentication has been revoked."}');

                this._setAuthenticationStatus(false, report);
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
                    //let logLine = " Api.js || " + "_setAuthenticationStatus || " + " Successfully Authenticated ";
                    //this.homey.app.writeLog(logLine);
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

    async getDevices (callback) {
        try {
            const result = await this.ringApi.fetchRingDevices()
            callback(null, result);
        }
        catch (error) {
            callback(error, null);
        }
    }

    async getAlarmDevices (callback) {
        try {
            const result = await this.location.getDevices()
            callback(null, result);
        }
        catch (error) {
            callback(error, null);
        }
    }

    ringChime (device_data, sound, callback) {
        //this.log('ringChime', device_data);
        this.chimes.forEach(async (chime) => {
            if (chime.id == device_data.id) {
                if (sound == 'ring') {
                    await this.chimes[this.chimes.indexOf(chime)].playSound('ding');
                } else {
                    await this.chimes[this.chimes.indexOf(chime)].playSound('motion');
                }
                callback(null,true);
            }
        });
    }

    snoozeChime(device_data, duration, callback) {
        //this.log('snoozeChime', device_data, duration);
        this.chimes.forEach(async (chime) => {
            if (chime.id == device_data.id) {
                chime.snooze(duration*60)  // duration is in minutes, max 24 * 60 (1440)
            }
            callback(null,true);
        });
    }

    unsnoozeChime(device_data, callback) {
        //this.log('unsnoozeChime', device_data);
        this.chimes.forEach(async (chime) => {
            if (chime.id == device_data.id) {
                chime.clearSnooze();
                callback(null,true);
            }
        });
    }

    // todo: Test new function
    lightOn (device_data, callback) {
        //this.log('lightOn', device_data);

        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                const result = camera.setLight(true);
                callback(null, result);
            }
        });
    }

    // todo: Test new function
    lightOff (device_data, callback) {
        this.log('lightOff', device_data);

        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                const result = camera.setLight(false);
                callback(null, result);
            }
        });
    }

    sirenOn (device_data, callback) {
        //this.log('sirenOn', device_data);

        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                const result = camera.setSiren(true);
                callback(null, result);
            }
        });
    }

    sirenOff (device_data, callback) {
        //this.log('sirenOff', device_data);

        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                const result = camera.setSiren(false);
                callback(null, result);
            }
        });
    }

    unlock (device_data, callback) {
        this.intercoms.forEach(async (intercom) => {
            if (intercom.initialData.id = device_data.id) {
                const result = await intercom.unlock();
                callback(null, result.result.code === 0);
            }
        })
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
            this.log('Api.js grabImage', error.toString());
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
            this.log('Api.js grabVideo', error.toString());
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
        if (kind.startsWith('lpd_')) return true;

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


    enableMotion (device_data, callback) {
        //this.log('enableMotion', device_data);
        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                let newSetting = this.getMotionSettings(true);
                const result =  await this.cameras[this.cameras.indexOf(camera)].setDeviceSettings(newSetting);
                const mAlerts =  await this.cameras[this.cameras.indexOf(camera)].subscribeToMotionEvents();
                callback(null, result);
            }
        });
    }

    disableMotion (device_data, callback) {
        //this.log('disableMotion', device_data);
        this.cameras.forEach(async (camera) => {
            if (camera.initialData.id == device_data.id) {
                let newSetting = this.getMotionSettings(false);
                const result =  await this.cameras[this.cameras.indexOf(camera)].setDeviceSettings(newSetting);
                const mAlerts =  await this.cameras[this.cameras.indexOf(camera)].unsubscribeFromMotionEvents();
                //this.log('disableMotion',result,'-');
                callback(null, result);
            }
        });
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

    mapLocationMode (mode) {
        return {
           mode: mode
        };
    }

    _setLocationMode (locationId,  mode, callback) {
        //this.log('_setLocationMode', mode)
        this.locations.forEach(async (location) => {
            if (location.locationDetails.location_id == locationId) {
                let result;
                const locationIndex = this.locations.indexOf(location);
                if ( this.location.hasAlarmBaseStation ) {
                    //this.log('_setLocationMode:         location has a Ring Alarm system')
                    try {
                        const alarmModes = { disarmed: 'none', home: 'some', away: 'all' };
                        result = await this.locations[locationIndex].setAlarmMode(alarmModes[mode]);
                        callback(null, result);
                    }
                    catch (error) {
                        this.log('_setLocationMode (Ring Alarm) error', error)
                        callback(error,null)
                    }
                } else {
                    //this.log('_setLocationMode:         location has no Ring Alarm system')
                    try {
                        result = await this.locations[locationIndex].setLocationMode(mode);
                        callback(null, result);
                    }
                    catch(error) {
                        this.log('_setLocationMode error', error)
                        callback(error,null)
                    }
                }
            }
        });
    }
}

module.exports = Api;
