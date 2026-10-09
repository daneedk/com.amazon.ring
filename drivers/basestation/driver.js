'use strict';

const Homey = require('homey');
const Driver = require('../../lib/Driver.js');

class DriverBasestation extends Driver {

    onInit() {
        this.log('onInit');

        this._triggerModeChange = this.homey.flow.getDeviceTriggerCard('ring_alarm_mode_changed');

        this._triggerCancelBurglarAlarm = this.homey.flow.getDeviceTriggerCard('alarm_burglar_false');
        this._triggerCancelFireAlarm = this.homey.flow.getDeviceTriggerCard('alarm_fire_false');
        this._triggerCancelMedicalAlarm = this.homey.flow.getDeviceTriggerCard('alarm_medical_false');
        this._triggerCancelPanicAlarm = this.homey.flow.getDeviceTriggerCard('alarm_panic_false');
        this._triggerEntryDelay = this.homey.flow.getDeviceTriggerCard('entry_delay');
        this._triggerBurglarAlarm = this.homey.flow.getDeviceTriggerCard('alarm_burglar_true');
        this._triggerFireAlarm = this.homey.flow.getDeviceTriggerCard('alarm_fire_true');
        this._triggerMedicalAlarm = this.homey.flow.getDeviceTriggerCard('alarm_medical_true');
        this._triggerPanicAlarm = this.homey.flow.getDeviceTriggerCard('alarm_panic_true');

        this.homey.flow.getConditionCard('alarm_burglar')
            .registerRunListener(async ( args, state ) => {
                return args.device.isAlarmBurglarOn();
            })

        this.homey.flow.getConditionCard('alarm_fire')
            .registerRunListener(async ( args, state ) => {
                return args.device.isAlarmFireOn();
            })

        this.homey.flow.getConditionCard('alarm_medical')
            .registerRunListener(async ( args, state ) => {
                return args.device.isAlarmMedicalOn();
            })

        this.homey.flow.getConditionCard('alarm_panic')
            .registerRunListener(async ( args, state ) => {
                return args.device.isAlarmPanicOn();
            })

        this.homey.flow.getConditionCard('basestation_mode_active')
            .registerRunListener(async ( args, state ) => {
                return args.device.isAlarmMode(args);
            })

        this.homey.flow.getActionCard('change_ring_alarm_mode')
            .registerRunListener(args => args.device.changeAlarmMode(args));

    }

    // this function is called from device.js
    modeChangeOn(device, tokens) {
        this._triggerModeChange.trigger(device, tokens)
            .then()
            .catch(this.error);
    }

    cancelAlarm(device, tokens) {
        this._triggerCancelBurglarAlarm.trigger(device, tokens)
            .then()
            .catch(this.error);

        this._triggerCancelFireAlarm.trigger(device, tokens)
            .then()
            .catch(this.error);

        this._triggerCancelMedicalAlarm.trigger(device, tokens)
            .then()
            .catch(this.error);

        this._triggerCancelPanicAlarm.trigger(device, tokens)
            .then()
            .catch(this.error);
    }

    entryDelay(device, tokens){
        this._triggerEntryDelay.trigger(device, tokens)
            .then()
            .catch(this.error);
    }

    burglarAlarm(device, tokens) {
        this._triggerBurglarAlarm.trigger(device,tokens)
            .then()
            .catch(this.error);
    }

    fireAlarm(device, tokens) {
        this._triggerFireAlarm.trigger(device,tokens)
            .then()
            .catch(this.error);
    }

    medicalAlarm(device, tokens) {
        this._triggerMedicalAlarm.trigger(device,tokens)
            .then()
            .catch(this.error);
    }

    panicAlarm(device, tokens) {
        this._triggerPanicAlarm.trigger(device,tokens)
            .then()
            .catch(this.error);
    }

    async onPairListDevices() {
        this.log('onPairListDevicesBasestation');

        const foundDevices = [];
        const result = await this.homey.app.getRingAlarmDevices();

        for (const device of result) {
            this.log('Device type found:', device.data.deviceType, device.data.name);

            if (device.data.deviceType === 'hub.redsky' || device.data.deviceType === 'hub.kili') {
                foundDevices.push({
                    name: device.data.name,
                    data: {
                        id: device.data.serialNumber,
                        catalogId: device.data.catalogId,
                        location: device.location.locationDetails.location_id,
                    },
                });
            }
        }

        return foundDevices;
    }

}

module.exports = DriverBasestation;
