'use strict';

const Homey = require('homey');
const Device = require('../../lib/Device.js');

const statusTimeout = 10000;

class DeviceStickUpCam extends Device {

    _initDevice() {
        this.log('_initDevice');
        //this.log('name:', this.getName());
        //this.log('class:', this.getClass());
        //this.log('data:', this.getData());

        this.device = {}
        this.device.timer = {};

        this.setCapabilityValue('alarm_motion', false).catch(error => {
            this.error(error);
        });

        this.setAvailable();

        this.homey.on('authenticationChanged', this._setAvailability.bind(this));

        this._setupCameraView(this.getData());

        this.homey.on('refresh_device', this._syncDevice.bind(this));
        this.homey.on('refresh_devices', this._syncDevices.bind(this));
        //Hook up the capabilities that are already known.
        if(this.hasCapability("flood_light"))
        {
            this.registerCapabilityListener('flood_light', this.onCapabilityFloodLight.bind(this));
        }
        if(this.hasCapability("siren"))
        {
            this.registerCapabilityListener('siren', this.onCapabilitySiren.bind(this));
        }
    }

    _setAvailability(status) {
        if (status == 'authenticated') {
            this.setAvailable();
        } else {
            this.setUnavailable(this.homey.__("devices.unauthenticated"));
        }
    }

    _enableLightCapability(device_data)
    {
        if(device_data.hasOwnProperty('led_status'))
        {
            //Adding new capabilities
            if(!this.hasCapability("flood_light"))
            {
                console.log('this stickup camera has light, enable the capabilit');
                this.addCapability("flood_light").then(function() {
                    this.registerCapabilityListener('flood_light', this.onCapabilityFloodLight.bind(this));
                }.bind(this));
            } 
        }
    }

    _enableSirenCapability(device_data)
    {
        if(device_data.hasOwnProperty('siren_status'))
        {
            console.log("device has a siren, enable siren related features");
            //Adding new capabilities
            if(!this.hasCapability("siren"))
            {
                console.log('this stickup camera has a siren, enable the capabilit');
                this.addCapability("siren").then(function() {
                    this.registerCapabilityListener('siren', this.onCapabilitySiren.bind(this));
                }.bind(this));
            }
            if(!this.hasCapability("alarm_generic"))
            {
                console.log('this stickup camera has a siren, so use it to detect a Alarm');
                this.addCapability("alarm_generic");
            } 
        } else {
            console.log('device has no siren, ignore siren related features');
        }
    }

    async _setupCameraView(device_data) {
        this.log('_setupCamera', device_data);
        //this.device.cameraImage = new Homey.Image();
        this.device.cameraImage = await this.homey.images.createImage();
        this.device.cameraImage.setStream(async (stream) => {
            await this.homey.app.grabImage(device_data, (error, result) => {
                if (!error) {
                    let Duplex = require('stream').Duplex;
                    let snapshot = new Duplex();
                    snapshot.push(Buffer.from(result, 'binary'));
                    snapshot.push(null);
                    return snapshot.pipe(stream);
                } else {
                    let logLine = " stickupcam || _setupCameraView || " + "_setupCameraView " + error;
                    this.homey.app.writeLog(logLine);
                    let Duplex = require('stream').Duplex;
                    let snapshot = new Duplex();
                    snapshot.push(null);
                    return snapshot.pipe(stream);
                    // This results in invalid_content_type
                }
            })
        })
        //this.device.cameraImage.register().catch(console.error).then(function() {
            this.setCameraImage(this.getName(),'snapshot',this.device.cameraImage);
        //}.bind(this));
    }

    _syncDevice(data) {
        if ( data.length > 0 ) {
            this.log('_syncDevice', data);
        }

        data.forEach((device_data) => {

            //Check ringing status
            if (device_data.state === 'ringing') {
                if (device_data.doorbot_id !== this.getData().id)
                    return;

                if (device_data.kind === 'motion' || device_data.motion) {
                    this.setCapabilityValue('alarm_motion', true).catch(error => {
                        this.error(error);
                    });

                    this.homey.app.logRealtime('stickupcam', 'motion');

                    clearTimeout(this.device.timer.motion);

                    this.device.timer.motion = setTimeout(() => {
                        this.setCapabilityValue('alarm_motion', false).catch(error => {
                            this.error(error);
                        });
                    }, statusTimeout);
                }
            }
        });
    }

    _syncDevices(data) {
        //this.log('_syncDevices', data);

        data.stickup_cams.forEach((device_data) => {
            if (device_data.id !== this.getData().id)
                return;

            //console.log(JSON.stringify(device_data.features));
            this._enableLightCapability(device_data);
            this._enableSirenCapability(device_data);
    

            if(this.hasCapability("flood_light"))
            {
                console.log('light status:'+device_data.led_status);
                let floodLight=false;
                if(device_data.led_status=='on')
                    floodLight=true;
                this.setCapabilityValue('flood_light', floodLight).catch(error => {
                    this.error(error);
                });
            }

            if(this.hasCapability("siren"))
            {
                console.log('siren status: '+JSON.stringify(device_data.siren_status));
                let siren=false;
                if(device_data.siren_status.seconds_remaining>0)
                    siren=true;
                this.setCapabilityValue('siren', siren).catch(error => {
                    this.error(error);
                });
                this.setCapabilityValue('alarm_generic', siren).catch(error => {
                    this.error(error);
                });
            }

            let battery = parseInt(device_data.battery_life);

            if (battery > 100)
                battery = 100;

            this.setCapabilityValue('measure_battery', battery).catch(error => {
                this.error(error);
            });
        });
    }

    grabImage(args, state) {
        if (this._device instanceof Error)
            return Promise.reject(this._device);

        let _this = this;
        return new Promise(function(resolve, reject) {
            _this.device.cameraImage.update().then(() =>{
                var tokens = {ring_image: _this.device.cameraImage};
                _this.homey.flow.getTriggerCard('ring_snapshot_received').trigger(tokens)
                    .catch(error => { _this.error(error); });
                
                return resolve(true);
            });
        });
    }

    isLightOn()
    {
        let _this = this;
        if(this.hasCapability('flood_light'))
        {
            return new Promise(function(resolve, reject) {
                return resolve(_this.getCapabilityValue('flood_light'));
            });
        }
        else
            return false;
    }

    onCapabilityFloodLight(value, opts)
	{
        console.log('flood light requested ['+value+']');
        this.setCapabilityValue('flood_light', value).catch(error => {
            this.error(error);
        });
        if(value)
            return this.lightOn();
        else
            return this.lightOff();
	}

    lightOn(args, state) {
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            this.homey.app.lightOn(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });       
    }

    lightOff(args, state) {
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            this.homey.app.lightOff(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });       
    }

    onCapabilitySiren(value, opts)
	{
        console.log('Siren requested ['+value+']');
        this.setCapabilityValue('siren', value).catch(error => {
            this.error(error);
        });
        if(value)
            return this.sirenOn();
        else
            return this.sirenOff();
    }
    
    sirenOn(args, state) {
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            this.homey.app.sirenOn(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });       
    }

    sirenOff(args, state) {
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            this.homey.app.sirenOff(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });       
    }

    enableMotion(args, state) {
        if (this._device instanceof Error)
            return Promise.reject(this._device);

        let _this = this;
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            _this.homey.app.enableMotion(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });
    }

    disableMotion(args, state) {
        if (this._device instanceof Error)
            return Promise.reject(this._device);

        let _this = this;
        let device_data = this.getData();

        return new Promise(function(resolve, reject) {
            _this.homey.app.disableMotion(device_data, (error, result) => {
                if (error)
                    return reject(error);

                return resolve(true);
            });
        });
    }

}

module.exports = DeviceStickUpCam;