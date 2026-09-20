const Homey = require('homey');
const Device = require('../../lib/Device.js');

const statusTimeout = 10000;

class DeviceIntercom extends Device {

    _initDevice() {
        this.log('_initDevice for', this.getName(), { id: this.getData().id });
        //this.log('class:', this.getClass());
        //this.log('data:', this.getData());

        this.device = {}
        this.device.timer = {};

        try {
            this.unlockTimeout = (this.getSetting('unlockTimeout') ?? 5) * 1000;
        } catch (e) {
            this.unlockTimeout = 5 * 1000;
        }

        this.setCapabilityValue('alarm_generic', false)
            .catch(error => {this.error(error)});

        this.setCapabilityValue('locked', true)
            .catch(error => {this.error(error)});

        // Add this device to the app registry
        this.homey.app._devices.push(this);

        // Set initial availability based on app authentication
        const initialStatus = this.homey.app?.isAuthenticated ? 'authenticated' : 'unauthenticated';
        this._setAvailability(initialStatus);

        this.homey.on('ringOnDing', this._ringOnDing.bind(this));
        //this.homey.on('ringOnData', this._ringOnData.bind(this));
        if (this.hasCapability("locked")) {
          this.registerCapabilityListener(
            "locked",
            this.onCapabilityLocked.bind(this)
          );
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

    _ringOnDing(device) {
        this.log('_ringOnDing (Intercom):',device)
        if (device.initialData.id !== this.getData().id)
            return;

        if (!this.getCapabilityValue("alarm_generic")) {
            this.homey.app.logRealtime("intercom", "ding");
            let logLine = "intercom || _ringOnNotification || " + this.getName() + " reported ding event";
            this.homey.app.writeLog(logLine);
        }

        this.setCapabilityValue("alarm_generic", true).catch((error) => {
            this.error(error);
        });

        clearTimeout(this.device.timer.ding);

        this.device.timer.ding = setTimeout(() => {
            this.setCapabilityValue("alarm_generic", false).catch(
                (error) => {
                    this.error(error);
                }
            );
        }, statusTimeout);
    }

    async ringOnData(data) {
        // this.log('Ring onData called from app.js for: ',data.description)
        if (data.id !== this.getData().id)
            return;

        //this.log('_ringOnData data',data);

        let battery = 100;

        if (data.battery_life != null) {
            // battery_life is not null, add measure_battery capability if it does not exists
            if ( !this.hasCapability('measure_battery') ) {
                await this.addCapability('measure_battery');
            }
            battery = parseInt(data.battery_life);

            if (battery > 100) { battery = 100; }

            if ( this.getCapabilityValue('measure_battery') != battery) {
                this.setCapabilityValue('measure_battery', battery)
                    .catch(error => {this.error(error)});
            }
        } else {
            // battery_life is null, remove measure_battery capability if it exists
            if ( this.hasCapability('measure_battery') ) {
                this.removeCapability('measure_battery')
                    .catch(error => {this.error(error)});
            }
        }
    }

    async onSettings( settings ) {
        settings.changedKeys.forEach((changedSetting) => {
            if (changedSetting == "unlockTimeout") {
                this.unlockTimeout = settings.newSettings.unlockTimeout * 1000;
            }
        })
    }

    onCapabilityLocked(value, opts)
	{
        if (!value) {
            this.log("Unlock requested");

            this.unlock().then((unlocked) => {
                this.setCapabilityValue("locked", !unlocked).catch((error) => this.error(error));

                this.log("Unlocked", unlocked);

                clearTimeout(this.device.timer.unlock);

                this.device.timer.unlock = setTimeout(() => {
                    this.log("Reverting back to locked state");
                    this.setCapabilityValue("locked", true)
                        .catch((error) => this.error(error));
                    this.device.timer.unlock = undefined;
                }, this.unlockTimeout);
            });
        } else {
            if (this.device.timer.unlock) {
                // just revert back to false and wait for the unlockTimeout to lock again
                setTimeout(() => this.setCapabilityValue("locked", false).catch((error) => this.error(error)), 10);
            } else {
                // more or less an error case when the timeout expired but locked was not set correctly
                this.log('Manually changing state to locked');
                this.setCapabilityValue("locked", true).catch((error) => this.error(error))
            }
        }
    }

    async unlock(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.unlock(device_data);
    }

}

module.exports = DeviceIntercom;
