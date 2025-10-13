require('./lib/polyfills');
const Homey = require('homey');
const api   = require('./lib/Api.js');
//const events = require('events');


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

        this.lastLocationModes = [];
        this.alarmSystem = { location: {} };

        this._api = new api(this.homey);

        this._api.on('ringOnNotification',this._ringOnNotification.bind(this));
        this._api.on('ringOnDing',this._ringOnDing.bind(this));
        this._api.on('ringOnData',this._ringOnData.bind(this));
        this._api.on('ringOnAlarmData',this._ringOnAlarmData.bind(this));
        this._api.on('ringOnLocation', this._ringOnLocation.bind(this));
        this.supportsModern = this._api.supportsModern;

        this._triggerLocationModeChangedTo = this.homey.flow.getTriggerCard('ring_location_mode_changed_generic');
        this.registerLocationModeChanged();

        this._conditionLocationMode = this.homey.flow.getConditionCard('ring_location_mode_active');
        this.conditionLocationMode();

        this._setLocationMode = this.homey.flow.getActionCard('change_location_mode');
        this.setLocationMode();

        this._triggerRingAlarmTriggered = this.homey.flow.getTriggerCard('ring_alarm_triggered');
        this.registerRingAlarmTriggered();

        this.log(`${Homey.manifest.id} ${Homey.manifest.version}    initialising done ---------`);

        // Purge the logfile
        this.homey.settings.set('myLog', '' );

        await this._api.init();

        //let logLine = " app.js || onInit || --------- " + `${Homey.manifest.id} ${Homey.manifest.version} started ---------`;
        //this.homey.app.writeLog(logLine);
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
        this.homey.emit('ringOnData', data);
    }

    // Called from event emitted from _connectRingAPI() in Api.js for Ring Alarm devices
    async _ringOnAlarmData(data) {
        if ( data.catalogId == this.alarmSystem.catalogId ) {
            if ( this.alarmSystem.mode != data.mode ) {
                // Mode changed
                this.log('this.alarmSystem: ', this.alarmSystem);
                
                this.alarmSystem.mode = data.mode
            }
            
            const isTriggered = (data.alarmInfo && data.alarmInfo.state === 'burglar-alarm') || (data.siren && data.siren.state === 'on');
            if (isTriggered) {
                this.triggerRingAlarmTriggered(
                    {
                        timestamp: new Date().toISOString()
                    },
                    {
                        location: this.alarmSystem.location
                    }
                );
            } 
        }

        this.homey.emit('ringOnAlarmData', data);
    }

    // Called from event emitted from _connectRingAPI() in Api.js
    _ringOnLocation(newLocationMode) {
        //this.log('_ringOnLocation',newLocationMode);
        if(this.lastLocationModes.length>0)
        {
            let matchedLastLocationMode = this.lastLocationModes.find(lastLocationMode =>{
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

    getRingDevices(callback) {
        this._api.getDevices(callback);
    }

    getRingAlarmDevices(callback) {
        this._api.getAlarmDevices(callback);
    }

    lightOn(data, callback) {
        this._api.lightOn(data, callback);
    }

    lightOff(data, callback) {
        this._api.lightOff(data, callback);
    }

    sirenOn(data, callback) {
        this._api.sirenOn(data, callback);
    }

    sirenOff(data, callback) {
        this._api.sirenOff(data, callback);
    }

    ringChime(data, sound, callback) {
        this._api.ringChime(data, sound, callback);
    }

    snoozeChime(data, duration, callback) {
        this._api.snoozeChime(data, duration, callback);
    }

    unsnoozeChime(data, callback) {
        this._api.unsnoozeChime(data, callback);
    }

    unlock(data, callback) {
        this._api.unlock(data, callback);
    }

    grabImage(data) {
        return this._api.grabImage(data);
    }

    grabVideo(data,offerSdp) {
        return this._api.grabVideo(data,offerSdp);
    }

    enableMotion(data, callback) {
        this._api.enableMotion(data, callback);
    }

    disableMotion(data, callback) {
        this._api.disableMotion(data, callback);
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
                return Promise.resolve( args.location.name === state.location.name );
            })
            .getArgument('location')
            .registerAutocompleteListener((query, args) => {
                return new Promise(async (resolve) => {
                    const locations = await this._api.userLocations();
                    //this.log('I found these locations',locations);
                    resolve(locations);
                });
            });
    }

    // flow condition
    conditionLocationMode() {
        this._conditionLocationMode
            .registerRunListener((args, state) => {
                return new Promise((resolve, reject) => {
                    var matchedLocationMode = this.lastLocationModes.find(lastLocationMode =>{
                        return lastLocationMode.id==args.location.id;
                    });
                    if(matchedLocationMode!=undefined) {
                        //this.log ('stored location mode found for location ' + matchedLocationMode.name);
                        resolve(matchedLocationMode.mode === args.mode);
                    } else {
                        //this.log ('stored location mode not found for location ' + args.location.id)
                        reject('unknown location');
                    }
                });
            })
            .getArgument('location')
            .registerAutocompleteListener((query, args) => {
                return new Promise(async (resolve) => {
                const locations = await this._api.userLocations();
                //this.log ('I found these locations',locations);
                resolve(locations);
                });
            });
    }

    // flow action
    setLocationMode() {
        this._setLocationMode
            .registerRunListener(async (args, state) => {
                //this.log ('attempt to switch location ('+args.location.name+') to new state: '+args.mode);
                return new Promise((resolve, reject) => {
                    this._api.setLocationMode(args.location.id,args.mode)
                        .then(() => {
                            resolve(true);
                        })
                        .catch((error) => {
                            reject(error);
                        })
                });
            })
            .getArgument('location')
            .registerAutocompleteListener((query, args) => {
                return new Promise(async (resolve) => {
                const locations = await this._api.userLocations();
                //this.log ('I found these locations',locations);
                resolve(locations);
                });
            });
    }

    // flow trigger
    // Ring alarm triggered flow trigger
    triggerRingAlarmTriggered(tokens, state) {
       if (this._triggerRingAlarmTriggered) {
            this._triggerRingAlarmTriggered.trigger(tokens, state);
       }
    }

    registerRingAlarmTriggered() {
        this._triggerRingAlarmTriggered
            .registerRunListener((args, state) => {
                return Promise.resolve(
                    args.location.id === state.location.id
                );
            })
            .getArgument('location')
            .registerAutocompleteListener((query, args) => {
                return new Promise(async (resolve) => {
                    const locations = await this._api.userLocations();
                    resolve(locations);
                });
            });
    }


    // Called from settingspages through api.js
    async getDevicesInfo() {
        //this.log('getDevicesInfo is called through api.js')
        return new Promise((resolve, reject) => {

            this.homey.app.getRingDevices((error, result) => {
                if (error) {
                return reject(error);
                }

                resolve(result);
            });

        });
    }

    // Write information to the Ring log and cleanup 20% when history above 2000 lines
    // - Called from multiple functions
    async writeLog(logLine) {
        let savedHistory = this.homey.settings.get('myLog');
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
        this.homey.settings.set('myLog', logLine );

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