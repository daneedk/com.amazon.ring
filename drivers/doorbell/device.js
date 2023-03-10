'use strict';

const Homey = require('homey');
const Device = require('../../lib/Device.js');

const statusTimeout = 10000;

class DeviceDoorbell extends Device {

    _initDevice() {
        this.log('_initDevice');
        //this.log('name:', this.getName());
        //this.log('class:', this.getClass());
        //this.log('data:', this.getData());

        this.device = {}
        this.device.timer = {};

        this.setCapabilityValue('alarm_generic', false).catch(error => {
            this.error(error);
        });

        this.setCapabilityValue('alarm_motion', false).catch(error => {
            this.error(error);
        });

        this.setAvailable();

        this.homey.on('authenticationChanged', this._setAvailability.bind(this));

        this._setupCameraView(this.getData());

        this.homey.on('refresh_device', this._syncDevice.bind(this));
        this.homey.on('refresh_devices', this._syncDevices.bind(this));
    }  
        
    _setAvailability(status) {
        if (status == 'authenticated') {
            this.setAvailable();
        } else {
            this.setUnavailable(this.homey.__("devices.unauthenticated"));
        }
    }
    
    async _setupCameraView(device_data) {
        this.log('_setupCamera', device_data);
        //this.device.cameraImage = new Homey.Image(); <- SDK2
        this.device.cameraImage = await this.homey.images.createImage();
        this.device.cameraImage.setStream(async (stream) => {
            this.log("setStream: request app.js grabImage (1)");
            await this.homey.app.grabImage(device_data, (error, result) => {
                this.log("setStream: app.js grabImage returned (4)");
                if (!error) {
                    let Duplex = require('stream').Duplex;
                    let snapshot = new Duplex();
                    snapshot.push(Buffer.from(result, 'binary'));
                    snapshot.push(null);
                    return snapshot.pipe(stream);
                } else {
                    let logLine = " doorbell || device.js _setupCameraView || " + this.getName() + " app.js grabImage reported: " + error;
                    this.homey.app.writeLog(logLine);
                    let Duplex = require('stream').Duplex;
                    let snapshot = new Duplex();
                    snapshot.push(null);
                    return snapshot.pipe(stream);
                    // This results in invalid_content_type
                    // To be continued...
                }
            })
        })

        this.setCameraImage(this.getName(),'snapshot',this.device.cameraImage)
            .catch(error =>{this.log("setCameraImage: ",error);})
    }

    _syncDevice(data) {
        if ( data.length > 0 ) {
            //this.log('_syncDevice data:', data);
        }

        data.forEach((device_data) => {

            //Check ringing status
            if (device_data.state === 'ringing') {
                if (device_data.doorbot_id !== this.getData().id)
                    return;

                if (device_data.kind === 'ding') {
                    if (!this.getCapabilityValue('alarm_generic')) {
                        this.homey.app.logRealtime('doorbell', 'ding');
                        let logLine = " doorbell || _syncDevice || " + this.getName() + " reported ding event";
                        this.homey.app.writeLog(logLine);
                    }
                    
                    this.setCapabilityValue('alarm_generic', true).catch(error => {
                        this.error(error);
                    });

                    clearTimeout(this.device.timer.ding);

                    this.device.timer.ding = setTimeout(() => {
                        this.setCapabilityValue('alarm_generic', false).catch(error => {
                            this.error(error);
                        });
                    }, statusTimeout);
                }

                if (device_data.kind === 'motion' || device_data.motion) {
                    if (!this.getCapabilityValue('alarm_motion')) {
                        this.homey.app.logRealtime('doorbell', 'motion');
                        let logLine = " doorbell || _syncDevice || " + this.getName() + " reported motion event";
                        this.homey.app.writeLog(logLine);
                    }

                    this.setCapabilityValue('alarm_motion', true).catch(error => {
                        this.error(error);
                    });

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
        // this.log('_syncDevices', data);

        data.doorbots.forEach( (device_data) => {
            // console.log(device_data.settings);
            // console.log(device_data.settings.motion_detection_enabled);
            // console.log(device_data.settings.lite_24x7.resolution_p); Snapshot size setting?
            // console.log(device_data.features);
            // console.log(device_data.alerts);
            // console.log(device_data.health);
            // console.log(device_data.owner);

            if (device_data.id !== this.getData().id)
                return;

            let battery = 100;
            
            if (device_data.battery_life != null) {
                // battery_life is not null, add measure_battery capability if it does not exists
                if ( !this.hasCapability('measure_battery') ) {
                    this.addCapability('measure_battery');
                }
                
                battery = parseInt(device_data.battery_life);
                
                if (battery > 100) { battery = 100; }
                                  
                if ( this.getCapabilityValue('measure_battery') != battery) {
                    this.setCapabilityValue('measure_battery', battery).catch(error => {
                        this.error(error);
                    });
                }
                
            } else {
                // battery_life is null, remove measure_battery capability if it exists
                if ( this.hasCapability('measure_battery') ) {
                    this.removeCapability('measure_battery');
                }
            }
   
            this.setSettings({useMotionDetection: device_data.settings.motion_detection_enabled})
                .catch((error) => {});
        });
    }

    grabImage(args, state) {  
        if (this._device instanceof Error)
            return Promise.reject(this._device);

        let _this = this;    
        return new Promise(function(resolve, reject) {
            _this.device.cameraImage.update()
                .then(() => {
                    _this.log("device.js grabImage: cameraImage.update()");
                    var tokens = {ring_image: _this.device.cameraImage};
                    _this.homey.flow.getTriggerCard('ring_snapshot_received')
                        .trigger(tokens)
                        .catch(error => {_this.log(error)})

                    return resolve(true);
                })
                .catch((error) =>{_this.log("grabImage error:",error)})
        });
    }

    async onSettings( settings ) {
        settings.changedKeys.forEach((changedSetting) => {
            if (changedSetting == 'useMotionDetection') {
                if (settings.newSettings.useMotionDetection) {
                    this.enableMotion(this._device)
                } else {
                    this.disableMotion(this._device)
                }
            }
        })
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

module.exports = DeviceDoorbell;
