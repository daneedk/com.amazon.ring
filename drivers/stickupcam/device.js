const Homey = require('homey');
const Device = require('../../lib/Device.js');

const statusTimeout = 10000;

class DeviceStickUpCam extends Device {

    _initDevice() {
        this.log('_initDevice for', this.getName(), this.getData());
        //this.log('class:', this.getClass());
        //this.log('data:', this.getData());

        this.device = {}
        this.device.timer = {};
        
        try {
            this.motionTimeout = this.getSetting('motionTimeout') ?? 30;
        } catch (e) {
            this.motionTimeout = 30;
        }
        
        try {
            this.motionAlerts = this.getSetting('useMotionAlerts') ?? true;
        } catch (e) {
            this.motionAlerts = true
        }

        this.setCapabilityValue('alarm_motion', false)
            .catch(error => {this.error(error)});
         
        // Add this device to the app registry
        this.homey.app._devices.push(this);

        // Set initial availability based on app authentication
        const initialStatus = this.homey.app?.isAuthenticated ? 'authenticated' : 'unauthenticated';
        this._setAvailability(initialStatus);

        this._setupCameraImage(this.getData());
        
        if (this.homey.hasFeature?.('camera-streaming')) {
            this._setupCameraVideo(this.getData());
        }

        this.homey.on('ringOnNotification', this._ringOnNotification.bind(this));
        //this.homey.on('ringOnData', this._ringOnData.bind(this));

        // Hook up the capabilities that are already known.
        if ( this.hasCapability("flood_light") ) {
            this.registerCapabilityListener('flood_light', this.onCapabilityFloodLight.bind(this));
        }
        if ( this.hasCapability("siren") ) {
            this.registerCapabilityListener('siren', this.onCapabilitySiren.bind(this));
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

    _enableLightCapability(device_data)
    {
        if(device_data.hasOwnProperty('led_status')) // camera.hasLight?
        {
            //Adding new capabilities
            if(!this.hasCapability("flood_light"))
            {
                //this.log('_enableLightCapability, this stickup camera has light, enable the capability');
                this.addCapability("flood_light").then(function() {
                    this.registerCapabilityListener('flood_light', this.onCapabilityFloodLight.bind(this));
                }.bind(this));
            } 
        }
    }

    _enableSirenCapability(device_data)
    {
        if(device_data.hasOwnProperty('siren_status')) // camera.hasSiren
        {
            //this.log ("_enableSirenCapability, device has a siren, enable siren related features");
            //Adding new capabilities
            if(!this.hasCapability("siren"))
            {
                //this.log ('_enableSirenCapability, this stickup camera has a siren, enable the capability');
                if ( this.getAvailable() ) {
                    this.addCapability("siren").then(function() {
                        this.registerCapabilityListener('siren', this.onCapabilitySiren.bind(this));
                    }.bind(this));
                }
            }
            /*
            if(this.hasCapability("alarm_generic"))
                {
                    this.removeCapability("alarm_generic");
                }
            */
        } else {
            //this.log ('_enableSirenCapability, device has no siren, ignore siren related features');
        }
    }

    async _setupCameraImage(device_data) {
        this.log('_setupCameraImage for', this.getName());

        this.device.cameraImage = await this.homey.images.createImage();
        this.device.cameraImage.setStream(async (stream) => {
            try {
                const result = await this.homey.app.grabImage(device_data);

                const { Duplex } = require('stream');
                const snapshot = new Duplex();
                snapshot.push(Buffer.from(result, 'binary'));
                snapshot.push(null);
                return snapshot.pipe(stream);
            } catch (error) {
                if (!error.message?.includes('unable to capture snapshots while streaming')) {
                    this.log('device.js grabImage', error);
                }

                const { Duplex } = require('stream');
                const snapshot = new Duplex();
                snapshot.push(null);
                return snapshot.pipe(stream);
            }
        });


        this.setCameraImage(this.getName(),'Snapshot',this.device.cameraImage)
            .catch(error =>{this.log("setCameraImage: ",error);})
    }

    async _setupCameraVideo(device_data) {
        this.log('_setupCameraVideo for', this.getName());

        try {
            this.device.cameraVideo = await this.homey.videos.createVideoWebRTC();
            // This gets called when a client (mobile app) wants to start viewing
            this.device.cameraVideo.registerOfferListener(async (offerSdp) => {
              
                let answerSdp = await this.homey.app.grabVideo(device_data,offerSdp);                

                return {
                    answerSdp
                };

            });

            await this.setCameraVideo(this.getName(), 'Live view', this.device.cameraVideo);
        }
        catch (error) {
            this.error('_setupCameraVideo: Error creating camera:', error);
        }

    }

    async _ringOnNotification(notification) {
        //if (notification.ding.doorbot_id !== this.getData().id)
        if (notification.data.device.id !== this.getData().id)
            return;

        /*
        this.log('------------------------------------------------------------------');
        this.log('notification.android_config.category',notification.android_config.category)
        this.log('notification.data.event.ding.detection_type:',notification.data.event.ding.detection_type)
        */

        //if (notification.action === 'com.ring.push.HANDLE_NEW_motion') {
        if (notification.android_config.category === 'com.ring.pn.live-event.motion') {
            await this.setCapabilityValue('alarm_motion', true)
                .catch(error => {this.error(error)});
            this.homey.app.logRealtime('stickupcam', 'motion');
            let logLine = "stickupcam || _ringOnNotification || " + this.getName() + " reported motion event";
            this.homey.app.writeLog(logLine);

            //const type = notification.ding.detection_type; // null, human, package_delivery, other_motion
            //const type = notification.ding.detection_type ? notification.ding.detection_type : null;
            const type = notification.data.event.ding.detection_type ? notification.data.event.ding.detection_type : null; 
            const tokens = { 'motionType' : this.motionTypes[type] || this.motionTypes.unknown }       
            if (this.motionAlerts) {
                this.driver.alarmMotionOn(this, tokens);
            }

            clearTimeout(this.device.timer.motion);

            this.device.timer.motion = setTimeout(() => {
                this.setCapabilityValue('alarm_motion', false)
                    .catch(error => {this.error(error)});
            }, (this.motionTimeout  * 1000));

            if( type === null ) throw new Error ('New detection type', notification.data.event.ding.detection_type);
        }
    }

    async ringOnData(data) {
        //this.log('_ringOnData data',data);

        this._enableLightCapability(data);
        this._enableSirenCapability(data);

        if(this.hasCapability("flood_light"))
        {
            //this.log('_ringOnData, light status:'+data.led_status);
            let floodLight=false;
            if(data.led_status=='on')
                floodLight=true;
            this.setCapabilityValue('flood_light', floodLight)
                .catch(error => {this.error(error)});
        }

        if(this.hasCapability("siren"))
        {
            if (data.siren_status.started_at) {
                //this.log('_ringOnData, Siren status: '+JSON.stringify(data.siren_status));
            }
            let siren=false;
            if(data.siren_status.seconds_remaining>0)
                siren=true;
            this.setCapabilityValue('siren', siren)
                .catch(error => {this.error(error)});

            /*
            this.setCapabilityValue('alarm_generic', siren)
                .catch(error => {this.error(error)});
            */
        }

        let battery = parseInt(data.battery_life);

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

        this.setSettings({useMotionDetection: data.settings.motion_detection_enabled})
            .catch((error) => {});
    }

    grabImage(args, state) {
        if (this._device instanceof Error)
            return Promise.reject(this._device);

        let _this = this;
        return new Promise(async function(resolve, reject) {
            _this.device.cameraImage.update()
                .then(() => {
                    var tokens = {ring_image: _this.device.cameraImage};
                    _this.homey.flow.getTriggerCard('ring_snapshot_received')
                        .trigger(tokens)
                        .catch(error => {_this.log(error)})

                    _this.driver.sendSnapshot(_this, tokens);

                return resolve(true);
                })
                .catch((error) =>{_this.log("grabImage error:",error)})
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
        // this.log('flood light requested ['+value+']');
        this.setCapabilityValue('flood_light', value)
            .catch(error => {this.error(error)});

        if(value)
            return this.lightOn();
        else
            return this.lightOff();
	}

    async lightOn(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.lightOn(device_data);
    }

    async lightOff(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.lightOff(device_data);
    }

    onCapabilitySiren(value, opts)
	{
        // this.log('Siren requested ['+value+']');
        this.setCapabilityValue('siren', value)
            .catch(error => {this.error(error)});
            
        if(value)
            return this.sirenOn();
        else
            return this.sirenOff();
    }
    
    async sirenOn(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.sirenOn(device_data);
    }

    async sirenOff(args) {
        if (this._device instanceof Error)
            throw this._device;

        const device_data = this.getData();
        return this.homey.app.sirenOff(device_data);
    }

    async onSettings(settings) {
        for (const changedSetting of settings.changedKeys) {
            if (changedSetting === 'useMotionDetection') {
                if (settings.newSettings.useMotionDetection) {
                    await this.enableMotion();
                } else {
                    await this.disableMotion();
                }
            } else if (changedSetting === 'useMotionAlerts') {
                this.motionAlerts = settings.newSettings.useMotionAlerts;
            } 
            else if (changedSetting === 'motionTimeout') {
                this.motionTimeout = settings.newSettings.motionTimeout;
            }
        }
    }

    async enableMotion() {
        if (this._device instanceof Error) {
            throw this._device;
        }

        const device_data = this.getData();
        await this.homey.app.enableMotion(device_data);
        return true;
    }

    async disableMotion() {
        if (this._device instanceof Error) {
            throw this._device;
        }

        const device_data = this.getData();
        await this.homey.app.disableMotion(device_data);
        return true;
    }

    async setMotionAlerts(state) {
        await this.setSettings({useMotionAlerts: state}); 
    }

}

module.exports = DeviceStickUpCam;