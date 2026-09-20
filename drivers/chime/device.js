const Homey = require('homey');
const Device = require('../../lib/Device.js');

class DeviceChime extends Device {

    _initDevice() {
        this.log('_initDevice for', this.getName(), { id: this.getData().id });
        //this.log('class:', this.getClass());
        //this.log('data:', this.getData());

        this.homey.app._devices.push(this);

        // Set initial availability based on app authentication
        const initialStatus = this.homey.app?.isAuthenticated ? 'authenticated' : 'unauthenticated';
        this._setAvailability(initialStatus);

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

    ringChime(args) {
        if (this._device instanceof Error)
            throw this._device;

            const device_data = this.getData();
            return this.homey.app.ringChime(device_data, args.sound);
    }

    snoozeChime(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return  this.homey.app.snoozeChime(device_data, args.duration);
    }

    unsnoozeChime() {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.unsnoozeChime(device_data);
    }

    /*
    https://github.com/tsightler/ring-mqtt/blob/b4fcec47a962f1249c9b659f298fef8a3f4bf712/devices/chime.js#L261C1-L265C19
    await this.setDeviceSettings({
        "night_light_settings": {
            "light_sensor_enabled": Boolean(command === 'on')
        }
    })

        async setDeviceSettings(settings) {
        const response = await this.device.restClient.request({
            method: 'PATCH',
            url: `https://api.ring.com/devices/v1/devices/${this.device.id}/settings`,
            json: settings
        })
        return response
    }
    */
}

module.exports = DeviceChime;
