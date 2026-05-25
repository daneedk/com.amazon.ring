const Homey = require('homey');
const Device = require('../../lib/Device.js');
const { locationModesHomey, locationModesAlarm } = require('../../lib/constants.js');
const { RingDeviceType } = require('../../ring-client-api');

const statusMapping = (status) => status !== "ok";
const sirenMapping = (status) => status !== "off";
const modeMapping = {"some": "home", "all": "away", "none": "disarmed"}

class DeviceBasestation extends Device {

    _initDevice() {
        this.log('_initDevice for', this.getName());
        // this.log('class:', this.getClass());
        // this.log('data:', this.getData());      
        
        this.setCapabilityValue('alarm_tamper', false)
            .catch(error => {this.error(error)});
        /*
        this.setCapabilityValue('alarm_power', false)
            .catch(error => {this.error(error)});

        this.setCapabilityValue('alarm_connectivity', false)
            .catch(error => {this.error(error)});
        */
        this.setCapabilityValue('power_source', 'ac')
            .catch(error => {this.error(error)});

        this.setCapabilityValue('connection_source', 'eth0')
            .catch(error => {this.error(error)});

        this.setCapabilityValue('homealarm_state', 'disarmed') //ring_alarm_state
            .catch(error => {this.error(error)});

        this.setCapabilityValue('alarm_burglar', false)
            .catch(error => {this.error(error)});

        this.setCapabilityValue('alarm_fire', false)
            .catch(error => {this.error(error)});

        this.setCapabilityValue('alarm_medical', false)
            .catch(error => {this.error(error)});

        this.setCapabilityValue('alarm_panic', false)
            .catch(error => {this.error(error)});

        // Add this device to the app registry
        this.homey.app._devices.push(this);

        // Set initial availability based on app authentication
        const initialStatus = this.homey.app?.isAuthenticated ? 'authenticated' : 'unauthenticated';
        this._setAvailability(initialStatus);

        //this.homey.on('ringOnAlarmData',this._ringOnAlarmData.bind(this));

        this.registerCapabilityListener('homealarm_state', this._onCapabilityRingAlarmState.bind(this))  //ring_alarm_state

    }

    async getSafeCapabilityValue(capability) {
        try {
            const value = this.getCapabilityValue(capability);
            if (value === undefined) {
                throw new Error(`${capability} capability not available`);
            }
            return value;
        } catch (error) {
            this.error(`getSafeCapabilityValue error (${capability}):`, error);
            throw error;
        }
    }

    async isAlarmPanicOn() {
        return this.getSafeCapabilityValue('alarm_panic');
    }

    async isAlarmMedicalOn() {
        return this.getSafeCapabilityValue('alarm_medical');
    }

    async isAlarmFireOn() {
        return this.getSafeCapabilityValue('alarm_fire');
    }

    async isAlarmBurglarOn() {
        return this.getSafeCapabilityValue('alarm_burglar');
    }

    async isAlarmMode(args)
    {
        try {
            const ringState = this.getCapabilityValue('homealarm_state');  //ring_alarm_state
            if (!ringState) throw new Error('homealarm_state capability not available');  //ring_alarm_state

            const baseStationMode = locationModesAlarm[ringState];
            if (baseStationMode === undefined) throw new Error(`Unknown ring state: ${ringState}`);

            return baseStationMode === args.mode;
        } catch (error) {
            this.error('isAlarmMode error:', error);
            throw error;
        }
    }    

    _setAvailability(status) {
        if (status == 'authenticated') {
            try {
                this.setAvailable();
            }
            catch(e) {
            }
        } else {
            try {
                if ( this.getAvailable() ) {
                    // this.getAvailable() always returns true, need other condition
                    this.setUnavailable(this.homey.__("devices.unauthenticated"));
                }
            }
            catch(e) {
                // fail silently, setting a device unavailable will fail when Homey itself failed it already
            }
        }
    }

    // Method called from app.js
    async ringOnAlarmData(data) {

        const isMyDevice = data.serialNumber === this.getData().id;
        const system = this.homey.app.alarmSystems.find(sys => sys.zid === data.zid);
        const isForThisSystem = system && system.location.id === this.getData().location;
        const isAdapterNone = data.adapterType === 'none';

        /*
        console.log('isMyDevice             ',isMyDevice)
        console.log('isForThisSystem        ',isForThisSystem)
        console.log('isAdapterNone          ',isAdapterNone)
        console.log(this.getData().location)
        console.log('--------------------------------------------')
        */

        if (!isMyDevice && !isForThisSystem ) { //&& !isAdapterNone) {
            // this.log(data.deviceType, data.name, data.zid, ':');
            // this.log(data);
            // this.log('----------------------------------------')
            return; // ignore data
        }

        // Exit Delay
        // this.log('_ringOnAlarmData                    deviceType:',data.deviceType,'alarmInfo.state', data.mode, data.transitionDelayEndTimestamp)
        // deviceType: 'security-panel' mode: 'all' data.transitionDelayEndTimestamp: timestamp (!=null)

        // Alarm Info
        // this.log('_ringOnAlarmData                     alarmInfo',data.alarmInfo)
        // data.alarmInfo: null
        // data.alarmInfo: { faultedDevices: [], state: 'keypad-medical-alarm', timestamp: 1760352901107, uuid: '0f0ac803-9225-40af-80f5-1dbd10960c76' }
        // data.alarmInfo: { faultedDevices: [], state: 'keypad-fire-alarm', timestamp: 1760352988748, uuid: '4919485b-6ac6-458d-b006-29a3f67e0bd2' }
        // data.alarmInfo: { faultedDevices: [], state: 'panic', timestamp: 1760353024195, uuid: '7a880883-6c0a-4fc3-8435-0973e2f4e268' }
        // data.alarmInfo: { faultedDevices: [ '1b31cd53-44f7-40de-8ed3-0427f481dcff' ], state: 'entry-delay', timestamp: 1760353151377, uuid: 'bd937095-077f-4f2a-95a5-61d19d3b7d35' }
        // data.alarmInfo: { state: 'burglar-alarm' }


        // Data to process from Basestation device:
        // Capabilities: https://apps-sdk-v3.developer.homey.app/tutorial-device-capabilities.html
        // tamperStatus     : ok - tamper           -> DONE
        // powerSource      : ac - battery.internal -> DONE
        // communication.   : eth0 - ppp0? - wlan0? -> DONE
        //
        // Data to process from security-panel device:
        // mode             : none - some - all     -> DONE
        //
        // result = this.locations[locationIndex].soundSiren();
        // result = this.locations[locationIndex].silenceSiren();
        //
        //     soundSiren() {
        //        return this.sendCommandToSecurityPanel('security-panel.sound-siren');
        //     }
        //     silenceSiren() {
        //        return this.sendCommandToSecurityPanel('security-panel.silence-siren');
        //     }
        //

        // Process information received from the basestation (hub.redsky)
        if ( data.deviceType == RingDeviceType["BaseStation"] ) {
            //this.log('=============================================')
            //this.log('Received from the basestation (hub.redsky):', data)
            //this.log('=============================================')

            // Set capabilities
            this.setCapabilityValue('alarm_tamper', statusMapping(data.tamperStatus))
                .catch(error => {this.error(error)});
            /*
            this.setCapabilityValue('alarm_power', statusMapping(data.acStatus))
                .catch(error => {this.error(error)});
            
            this.setCapabilityValue('alarm_connectivity', statusMapping(data.commStatus))
                .catch(error => {this.error(error)});
            */
            this.setCapabilityValue('power_source', data.powerSource)
                .catch(error => {this.error(error)});

            this.setCapabilityValue('connection_source', data.networkConnection)
                .catch(error => {this.error(error)});    

            // Set Battery Capability
            let battery = 100;

            if ( data.batteryStatus != null ) {
                if ( data.batteryStatus === 'charged' || data.batteryStatus === 'full' ) {
                    battery = 100;
                } else {
                    battery = parseInt(data.batteryStatus);
                }
                if (battery > 100) { battery = 100; }            
                this.setCapabilityValue('measure_battery', battery)
                    .catch(error => {this.error(error)});
            }

        } else {
            // Process information received from Alarm System (security-panel)
            /*
            this.log('=============================================')
            this.log('Received from the Alarm System (security-panel):', data)
            this.log('=============================================')
            */

            await this.setCapabilityValue('homealarm_state', locationModesHomey[data.mode])  //ring_alarm_state
                .catch(error => {this.error(error)});

            await new Promise(resolve => setTimeout(resolve, 0));

            if ( data.mode != system.oldmode ) {
                const tokens = { mode: modeMapping[data.mode], oldmode: modeMapping[system.oldmode] }
                this.driver.modeChangeOn(this,tokens);
                this.log('Basestation', data.name, 'in', system.location.name ,'changed from',system.oldmode ,'to',data.mode);
                system.oldmode = data.mode;
                
            }

            this.log(data.alarmInfo);

            if (data.alarmInfo === undefined) return;
            
            if (data.alarmInfo === null) {
                this.log('Alarm canceled');
                this.setCapabilityValue('alarm_burglar', false)
                    .catch(error => {this.error(error)});
                this.setCapabilityValue('alarm_fire', false)
                    .catch(error => {this.error(error)});
                this.setCapabilityValue('alarm_medical', false)
                    .catch(error => {this.error(error)});                 
                this.setCapabilityValue('alarm_panic', false)
                    .catch(error => {this.error(error)});    
                this.driver.cancelAlarm(this, { timestamp: new Date().toISOString() });
            } else if (data.alarmInfo.state === 'entry-delay') {
                this.log('Entry Delay', data.alarmInfo?.faultedDevices[0]);

                const zid = data?.alarmInfo?.faultedDevices?.[0];
                const device = Object.values(this.homey.app._devices).find(d => d.getData()?.zid === zid);
                const nameSymbol = Object.getOwnPropertySymbols(device ?? {}).find(s => s.description === 'name');
                const name = device?.[nameSymbol];
                const tokens = { faultedDevices: name }
                
                this.driver.entryDelay(this, tokens);
            } else if (data.alarmInfo.state === 'burglar-alarm') {
                this.log('Burglar Alarm');
                this.setCapabilityValue('alarm_burglar', true)
                    .catch(error => {this.error(error)});                
                this.driver.burglarAlarm(this, { timestamp: new Date().toISOString() });
            } else if (data.alarmInfo.state === 'keypad-fire-alarm') {
                this.log('Fire Alarm');
                this.setCapabilityValue('alarm_fire', true)
                    .catch(error => {this.error(error)});
                this.driver.fireAlarm(this, { timestamp: new Date().toISOString() });
            } else if (data.alarmInfo.state === 'keypad-medical-alarm') {
                this.log('Medical Alarm');
                this.setCapabilityValue('alarm_medical', true)
                    .catch(error => {this.error(error)}); 
                this.driver.medicalAlarm(this, { timestamp: new Date().toISOString() });
            }  else if (data.alarmInfo.state === 'panic') {
                this.log('Panic Alarm');
                this.setCapabilityValue('alarm_panic', true)
                    .catch(error => {this.error(error)});
                this.driver.panicAlarm(this, { timestamp: new Date().toISOString() });
            }

        }
    }
    
    changeAlarmMode(args) {
        if (this._device instanceof Error)
            throw this._device;

        return this.homey.app._api.setLocationMode(this.getData().location,args.mode)
            .then(result => { 
                return result 
            })
            .catch(error => {
                this.error(error);
                return Promise.reject(error);
            })
    }

    _onCapabilityRingAlarmState(newState, opts) {

        this.log('onCapabilityRingAlarmState:', newState)
        this.log('Selected mode:',locationModesAlarm[newState])
        this.log('Basestation location:',this.getData().location)

        return this.homey.app._api.setLocationMode(this.getData().location, locationModesAlarm[newState])
            .then(result => true)
            .catch(error => {
                this.error(error);
                throw error; // ensures Homey knows it failed
            });
    }

}

module.exports = DeviceBasestation;
