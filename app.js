const Homey = require('homey');
const api   = require('./lib/Api.js');

// !!!! remove next lines before publishing !!!!
// const LogToFile = require('homey-log-to-file'); // https://github.com/robertklep/homey-log-to-file

class App extends Homey.App {

    async onInit() {
        // !!!! remove next lines before publishing !!!!
        /*    
        const runningVersion = this.parseVersionString(Homey.manifest.version);
        if (process.env.DEBUG === '1' || runningVersion.patch % 2 != 0) { // either when running from console or odd patch version
            await LogToFile();
            // log at: http://<homey IP>:8008
        }
        */

        this.log(`${Homey.manifest.id} ${Homey.manifest.version}    initialising --------------`);

        this.isDebugEnabled = !!(await this.homey.settings.get('isDebugEnabled'));

        // Registry for all devices
        this._devices = []; // deviceId -> device instance

        this.lastLocationModes = [];
        
        this.homey.app.alarmSystems = [];

        this._api = new api(this.homey);

        this._api.on('ringOnNotification',this._ringOnNotification.bind(this));
        this._api.on('ringOnDing',this._ringOnDing.bind(this));
        this._api.on('ringOnData',this._ringOnData.bind(this));
        this._api.on('ringOnAlarmData',this._ringOnAlarmData.bind(this));
        this._api.on('ringOnLocation', this._ringOnLocation.bind(this));

        this._triggerLocationModeChangedTo = this.homey.flow.getTriggerCard('ring_location_mode_changed_generic');
        this.registerLocationModeChanged();

        this._triggerAppError = this.homey.flow.getTriggerCard('app_error_occurred');
        this.registerAppError();

        this._conditionLocationMode = this.homey.flow.getConditionCard('ring_location_mode_active');
        this.conditionLocationMode();

        this._setLocationMode = this.homey.flow.getActionCard('change_location_mode');
        this.setLocationMode();

        // catch all errors and send them to the log and flowcard
        const original = console.error;

        console.error = (...args) => {
            let errorText;

            errorText = args.map(arg => {
                if (arg instanceof Error) {
                    return arg.stack || arg.toString();
                }
                return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
            }).join(' ');

            this.homey.app.writeLog(errorText);
            const tokens = { error: errorText };
            this.triggerAppError(tokens);

            original(...args);
        };

        this.log(`${Homey.manifest.id} ${Homey.manifest.version}    initialising done ---------`);

        // Purge the logfile
        // this.homey.settings.set('debugLog', '' );

        await this._api.init();

        // new code for authentication
        this.homey.on('authenticationChanged', this._onAuthenticationChanged.bind(this));

        let logLine = "===============================================================================================";
        this.homey.app.writeLog(logLine);

        logLine = "app.js || onInit || --------- " + `${Homey.manifest.id} ${Homey.manifest.version} started ---------`;
        this.homey.app.writeLog(logLine);
      
    }

    async onUninit() {
        this._api._disconnectRingAPI();
    }

    // make the authentication status available to devices by retrieving this.homey.app.isAuthenticated()
    // new code for authentication
    isAuthenticated() {
        return !!this._api._authenticated;
    }

    // new code for authentication
    _onAuthenticationChanged(status) {
        this._api._authenticated = status === 'authenticated';
        Object.values(this._devices).forEach(device => {
            if (typeof device._setAvailability === 'function') {
                device._setAvailability(status);
            }
        });
    }

    // Called from event emitted from _connectRingAPI() in Api.js
    _ringOnNotification(notification) {
        this.homey.emit('ringOnNotification', notification);
    }

    // Called from event emitted from _connectRingAPI() in Api.js
    _ringOnDing(device) {
        this.homey.emit("ringOnDing", device);
    }

    // Called from event emitted from _connectRingAPI() in Api.js
    _ringOnData(data) {
        // Find the device for which this message is and call its function to act on it
        Object.values(this._devices).forEach(device => {
            if ( data.id === device.getData().id) {
                device.ringOnData?.(data);
            }
        });        
    }

    // Called from event emitted from _connectRingAPI() in Api.js for Ring Alarm devices
    _ringOnAlarmData(data) {
        // Find the alarm system matching this zid
        const system = this.homey.app.alarmSystems.find(s => s.zid === data.zid);

        // Update system mode only if a matching system is found
        if (system && system.mode !== data.mode) {
            this.log('Alarm system mode changed for', system.location.name,'to',data.mode);
            system.mode = data.mode;
            let logLine = "app.js || _ringOnAlarmData || Alarm system mode changed for " + system.location.name + " to " + data.mode
            this.homey.app.writeLog(logLine);
        }

        // Always emit the event, DEPRECATED
        // this.homey.emit('ringOnAlarmData', data);

        // find the device for which this message is and call its function to act on it
        Object.values(this._devices).forEach(device => {
            if ( data.serialNumber === device.getData().id || system ) {
                device.ringOnAlarmData?.(data);
            }
        });
    }

    // Called from event emitted from _connectRingAPI() in Api.js
    _ringOnLocation(newLocationMode) {
        //this.log('_ringOnLocation',newLocationMode);
        if(this.lastLocationModes.length>0)
        {
            const matchedLastLocationMode = this.lastLocationModes.find(lastLocationMode =>{
                 return lastLocationMode.id==newLocationMode.id;
            });
            if(matchedLastLocationMode!=undefined)
            {
                //console.log('Check location mode for remembered location '+matchedLastLocationMode.name+' was in mode '+matchedLastLocationMode.mode+' and now is in mode '+newLocationMode.mode);
                if(matchedLastLocationMode.mode!=newLocationMode.mode)
                {
                    //console.log('location mode changed, raise the flow trigger!');
                    this.triggerLocationModeChanged({oldmode: matchedLastLocationMode.mode, mode: newLocationMode.mode},{location: newLocationMode});
                }
                matchedLastLocationMode.mode = newLocationMode.mode;
            }
            else {
                //console.log('recevied new location mode for location '+newLocationMode.name+', there is no old state known for this location');
                this.lastLocationModes.push(newLocationMode);
            }
        } else{
            //console.log('recevied new location mode for location '+newLocationMode.name+', there is no old state known for this location');
            this.lastLocationModes.push(newLocationMode);
        }
    }

    ringChime(data, sound) {
        return this._api.ringChime(data, sound);
    }

    snoozeChime(data, duration) {
        return this._api.snoozeChime(data, duration);
    }

    unsnoozeChime(data) {
        return this._api.unsnoozeChime(data);
    }

    lightOn(data) {
        return this._api.lightOn(data);
    }

    lightOff(data) {
        return this._api.lightOff(data);
    }

    sirenOn(data) {
        return this._api.sirenOn(data);
    }

    sirenOff(data) {
        return this._api.sirenOff(data);
    }

    unlock(data) {
        return this._api.unlock(data);
    }

    grabImage(data) {
        return this._api.grabImage(data);
    }

    grabVideo(data,offerSdp) {
        return this._api.grabVideo(data,offerSdp);
    }

    async getRingDevices() {
        return await this._api.getDevices();
    }

    async getRingAlarmDevices() {
        return await this._api.getAlarmDevices();
    }

    async enableMotion(data) {
        return this._api.enableMotion(data);
    }

    async disableMotion(data) {
        return this._api.disableMotion(data);
    }

    async useFloodlightOnMotion(data,useFloodlightOnMotion) {
        return this._api.useFloodlightOnMotion(data,useFloodlightOnMotion)
    }


    logRealtime(event, details) {
        this.homey.api.realtime(event, details)
        // this.log('Realtime event emitted for', event, details);
    }

    // flowcard functions
    // flow trigger
    triggerLocationModeChanged(tokens, state) {
        this._triggerLocationModeChangedTo.trigger(tokens, state);
    }

    registerLocationModeChanged() {
        this._triggerLocationModeChangedTo
            .registerRunListener((args, state) => {
                return args.location.name === state.location.name;
            })
            .getArgument('location')
            .registerAutocompleteListener(async () => {
                const locations = await this._api.userLocations();
                // this.log('I found these locations', locations);
                return locations;
            });
    }

    registerAppError() {
        this._triggerAppError.registerRunListener();
    }

    triggerAppError(tokens) {
        this._triggerAppError.trigger(tokens);
    }

    // flow condition
    conditionLocationMode() {
        this._conditionLocationMode
            .registerRunListener(async (args) => {
                const matchedLocationMode = this.lastLocationModes.find(
                    (lastLocationMode) => lastLocationMode.id === args.location.id
                );
                if (matchedLocationMode) {
                    // this.log('stored location mode found for location ' + matchedLocationMode.name);
                    return matchedLocationMode.mode === args.mode; // resolves true/false
                } else {
                    // this.log('stored location mode not found for location ' + args.location.id);
                    throw new Error('unknown location');
                }
            })
            .getArgument('location')
            .registerAutocompleteListener(async () => {
                const locations = await this._api.userLocations();
                // this.log('I found these locations', locations);
                return locations;
            });
    }

    // flow action
    setLocationMode() {
        this._setLocationMode
            .registerRunListener(async (args) => {
                // this.log('attempt to switch location (' + args.location.name + ') to new state: ' + args.mode);
                await this._api.setLocationMode(args.location.id, args.mode);
                return true;
            })
            .getArgument('location')
            .registerAutocompleteListener(async (query, args) => {
                const locations = await this._api.userLocations();
                // this.log('I found these locations', locations);
                return locations; 
            });
    }

    // Called from settings pages through api.js
    async getDevicesInfo() {
        try {
            return await this.homey.app.getRingDevices();
        } catch (error) {
            this.error(error);
            throw error;
        }
    }

    // Write information to the Ring log and cleanup 20% when history above 2000 lines
    // - Called from multiple functions
    async writeLog(logLine) {
        if (!this.isDebugEnabled) return;

        let savedHistory = this.homey.settings.get('debugLog');
        if ( savedHistory != undefined ) {
            // cleanup history
            let lineCount = savedHistory.split(/\r\n|\r|\n/).length;
            if ( lineCount > 200 ) {
                let deleteItems = parseInt( lineCount * 0.2 );
                let savedHistoryArray = savedHistory.split(/\r\n|\r|\n/);
                let cleanUp = savedHistoryArray.splice(-1*deleteItems, deleteItems, "" );
                savedHistory = savedHistoryArray.join('\n');
            }
            // end cleanup
            logLine = this.getDateTime() + logLine + "\n" + savedHistory;
        } else {
            this.log("writeLog: savedHistory is undefined!")
        }
        this.homey.settings.set('debugLog', logLine );

        logLine = "";
    }

    // Support functions

    // Returns a date timestring including milliseconds to be used in loglines
    // - Called from multiple functions
    getDateTime() {
        let timezone = this.homey.clock.getTimezone()
        let date = new Date(new Date().toLocaleString("en-US", {timeZone: timezone}));
        let dateMsecs = new Date();

        let hour = date.getHours();
        hour = (hour < 10 ? "0" : "") + hour;
        let min  = date.getMinutes();
        min = (min < 10 ? "0" : "") + min;
        let sec  = date.getSeconds();
        sec = (sec < 10 ? "0" : "") + sec;
        let msec = ("00" + dateMsecs.getMilliseconds()).slice(-3)
        let year = date.getFullYear();
        let month = date.getMonth() + 1;
        month = (month < 10 ? "0" : "") + month;
        let day  = date.getDate();
        day = (day < 10 ? "0" : "") + day;
        return day + "-" + month + "-" + year + "  ||  " + hour + ":" + min + ":" + sec + "." + msec + "  ||  ";
    }

    // returns the supplied version in a usable format; version.major, version.minor, version.path
    parseVersionString(version) {
        if (typeof(version) != 'string') { return false; }
        var x = version.split('.');
        // parse from string or default to 0 if can't parse
        var maj = parseInt(x[0]) || 0;
        var min = parseInt(x[1]) || 0;
        var pat = parseInt(x[2]) || 0;
        return {
            major: maj,
            minor: min,
            patch: pat
        }
    }

}

module.exports = App;