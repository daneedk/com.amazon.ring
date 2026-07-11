const Homey = require('homey');
const Driver = require('../../lib/Driver.js');

class DriverStickUpCam extends Driver {

    onInit() {
        this.log('onInit');

        this._triggerAlarmMotionOn = this.homey.flow.getDeviceTriggerCard('alarm_motion_true');
        this._triggerSendSnapshot = this.homey.flow.getDeviceTriggerCard('ring_snapshot_received_device');

        if (!this.homey.__alarmMotionListenerRegistered) {
            this.homey.__alarmMotionListenerRegistered = true;
            
            this.homey.flow.getConditionCard('alarm_motion')
                .registerRunListener(async ( args, state ) => {
                    return args.device.getCapabilityValue('alarm_motion');
                })
        }

        this.homey.flow.getConditionCard('stickupcam_floodLight_on')
            .registerRunListener(async ( args, state ) => {
                return args.device.isLightOn(); // Promise<boolean>
            })
            
        this.homey.flow.getActionCard('stickupcam_grab_snapshot')
            .registerRunListener((args, state) => args.device.grabImage());

        this.homey.flow.getActionCard('stickupcam_light_on')
            .registerRunListener(args => args.device.lightOn());

        this.homey.flow.getActionCard('stickupcam_light_off')
            .registerRunListener(args => args.device.lightOff());

        this.homey.flow.getActionCard('stickupcam_siren_on')
            .registerRunListener(args => args.device.sirenOn());

        this.homey.flow.getActionCard('stickupcam_siren_off')
            .registerRunListener(args => args.device.sirenOff());

        this.homey.flow.getActionCard('stickupcam_enable_motion')
            .registerRunListener((args, state) => args.device.enableMotion());

        this.homey.flow.getActionCard('stickupcam_disable_motion')
            .registerRunListener((args, state) => args.device.disableMotion());
        
        this.homey.flow.getActionCard('stickupcam_enable_motion_alerts')
            .registerRunListener((args, state) => args.device.setMotionAlerts(true));

        this.homey.flow.getActionCard('stickupcam_disable_motion_alerts')
            .registerRunListener((args, state) => args.device.setMotionAlerts(false));

        this.homey.flow.getActionCard('stickupcam_enable_floodlight_on_motion')
            .registerRunListener((args, state) => args.device.useFloodlightOnMotion(true));

        this.homey.flow.getActionCard('stickupcam_disable_floodlight_on_motion')
            .registerRunListener((args, state) => args.device.useFloodlightOnMotion(false));
    }

    // this function is called from driver.js
    alarmMotionOn(device, tokens) {
        this._triggerAlarmMotionOn.trigger(device, tokens)
            .then(() => this.log('alarmMotionOn triggered for', device.getName()))
            .catch(error => { this.log('alarmMotionOn error for', device.getName(), error) })
    }

    sendSnapshot(device, tokens) {
        this._triggerSendSnapshot.trigger(device, tokens)
            .then(() => this.log('sendSnapshot triggered for', device.getName()))
            .catch(error => {this.log('grabImage trigger error for', device.getName(), error) })
    }

    async onPairListDevices() {
        this.log('onPairListDevices');

        try {
            const result = await this.homey.app.getRingDevices();
            return result.stickupCams.map(device => ({
                name: device.description,
                data: { id: device.id }
            }));
        } catch (error) {
            this.error(error);
            throw error;
        }
    }

}

module.exports = DriverStickUpCam;
