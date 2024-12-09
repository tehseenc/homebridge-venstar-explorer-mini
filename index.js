'use strict';

const axios = require('axios');
let hap;

module.exports = (api) => {
  hap = api.hap;
  api.registerPlatform("VenstarExplorerMini", VenstarExplorerMiniPlatform);
};

class VenstarExplorerMiniPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    this.thermostats = config.thermostats || [];
    this.accessories = [];

    if (!this.thermostats.length) {
      this.log.warn('No thermostats configured.');
    }

    // Homebridge calls configureAccessory for cached accessories
    // We just record them so we can update or use them later in didFinishLaunching
    this.api.on('didFinishLaunching', () => {
      this.log('didFinishLaunching');

      const existingUUIDs = this.accessories.map(a => a.UUID);
      for (const thermostatConfig of this.thermostats) {
        const uuid = this.api.hap.uuid.generate('homebridge:venstar:' + thermostatConfig.ip);
        const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

        if (existingAccessory) {
          this.log(`Updating existing accessory: ${thermostatConfig.name}`);
          // Update config on the existing accessory's instance
          existingAccessory.context.config = thermostatConfig;
          // If the accessory instance was created in configureAccessory(), it should already have handlers.
          // If not, and we need to ensure handlers, we can reinitialize here, 
          // but first remove old services or check if it's already initialized.
          if (!existingAccessory.context.initialized) {
            new VenstarThermostatAccessory(this.log, thermostatConfig, this.api, existingAccessory);
            existingAccessory.context.initialized = true;
          } else {
            // If already initialized, just update the accessory context/config if needed.
          }

        } else {
          this.log(`Adding new accessory: ${thermostatConfig.name}`);
          const accessory = new this.api.platformAccessory(thermostatConfig.name, uuid);
          accessory.context.config = thermostatConfig;
          new VenstarThermostatAccessory(this.log, thermostatConfig, this.api, accessory);
          accessory.context.initialized = true;
          this.api.registerPlatformAccessories("homebridge-venstar-explorer-mini-dec-2024", "VenstarExplorerMini", [accessory]);
          this.accessories.push(accessory);
        }
      }
    });
  }

  configureAccessory(accessory) {
    // This is called when Homebridge restores cached accessories upon restart
    this.log(`Configuring cached accessory: ${accessory.displayName}`);
    // Do NOT create a new VenstarThermostatAccessory here directly.
    // Just store the accessory. We'll fully initialize it in didFinishLaunching.
    this.accessories.push(accessory);
  }
}

class VenstarThermostatAccessory {
  constructor(log, config, api, accessory) {
    this.log = log;
    this.api = api;
    this.accessory = accessory;
    this.name = config.name || "Venstar Thermostat";
    this.ip = config.ip;

    this.currentTemperature = 20;
    this.targetTemperature = 22;
    this.currentHeatingCoolingState = hap.Characteristic.CurrentHeatingCoolingState.OFF;
    this.targetHeatingCoolingState = hap.Characteristic.TargetHeatingCoolingState.AUTO;
    this.temperatureDisplayUnits = hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.userChangedUnits = false;
    this.fanOn = false;

    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, "Venstar")
      .setCharacteristic(hap.Characteristic.Model, "Explorer Mini");

    this.thermostatService = this.accessory.getService(hap.Service.Thermostat)
      || this.accessory.addService(hap.Service.Thermostat, this.name);

    this.fanService = this.accessory.getService(hap.Service.Fan)
      || this.accessory.addService(hap.Service.Fan, `${this.name} Fan`);

    // Set up handlers exactly once
    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', (callback) => {
        callback(null, this.currentHeatingCoolingState);
      });

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          hap.Characteristic.TargetHeatingCoolingState.OFF,
          hap.Characteristic.TargetHeatingCoolingState.HEAT,
          hap.Characteristic.TargetHeatingCoolingState.COOL,
          hap.Characteristic.TargetHeatingCoolingState.AUTO
        ]
      })
      .on('get', (callback) => {
        callback(null, this.targetHeatingCoolingState);
      })
      .on('set', this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', (callback) => {
        callback(null, this.currentTemperature);
      });

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', (callback) => {
        callback(null, this.targetTemperature);
      })
      .on('set', this.handleTargetTemperatureSet.bind(this))
      .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 });

    this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .on('get', (callback) => {
        callback(null, this.temperatureDisplayUnits);
      })
      .on('set', this.handleTemperatureDisplayUnitsSet.bind(this));

    this.fanService.getCharacteristic(hap.Characteristic.On)
      .on('get', async (callback) => {
        try {
          const response = await axios.get(`http://${this.ip}/query/info`);
          const data = response.data;
          this.fanOn = (data.fan === 1);
          callback(null, this.fanOn);
        } catch (err) {
          this.log.error('Error getting fan state:', err.message);
          callback(err);
        }
      })
      .on('set', this.handleFanOnSet.bind(this));

    this.pollThermostat();
    this.pollInterval = setInterval(() => {
      this.pollThermostat();
    }, 60 * 1000);
  }

  async pollThermostat() {
    try {
      const infoUrl = `http://${this.ip}/query/info`;
      const response = await axios.get(infoUrl);
      const data = response.data;

      const modeMap = {
        0: hap.Characteristic.TargetHeatingCoolingState.OFF,
        1: hap.Characteristic.TargetHeatingCoolingState.HEAT,
        2: hap.Characteristic.TargetHeatingCoolingState.COOL,
        3: hap.Characteristic.TargetHeatingCoolingState.AUTO,
      };

      this.currentTemperature = this.convertToHomeKitTemp(data.spacetemp, data.tempunits);
      this.targetTemperature = this.determineTargetTemperature(data);
      this.targetHeatingCoolingState = modeMap[data.mode] || hap.Characteristic.TargetHeatingCoolingState.OFF;
      this.currentHeatingCoolingState = this.determineCurrentState(data.state);

      if (!this.userChangedUnits) {
        this.temperatureDisplayUnits = (data.tempunits === 0)
          ? hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
      }

      this.fanOn = (data.fan === 1);

      this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentTemperature, this.currentTemperature);
      this.thermostatService.updateCharacteristic(hap.Characteristic.TargetTemperature, this.targetTemperature);
      this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState);
      this.thermostatService.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState);
      this.thermostatService.updateCharacteristic(hap.Characteristic.TemperatureDisplayUnits, this.temperatureDisplayUnits);

      this.fanService.updateCharacteristic(hap.Characteristic.On, this.fanOn);

    } catch (err) {
      this.log.error('Error polling thermostat:', err.message);
    }
  }

  determineTargetTemperature(data) {
    if (data.mode === 3) {
      const avg = (data.heattemp + data.cooltemp) / 2;
      return this.convertToHomeKitTemp(avg, data.tempunits);
    }
    if (data.mode === 1) return this.convertToHomeKitTemp(data.heattemp, data.tempunits);
    if (data.mode === 2) return this.convertToHomeKitTemp(data.cooltemp, data.tempunits);
    return this.convertToHomeKitTemp(data.spacetemp, data.tempunits);
  }

  determineCurrentState(state) {
    if (state === 1) return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
    if (state === 2) return hap.Characteristic.CurrentHeatingCoolingState.COOL;
    return hap.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  convertToHomeKitTemp(temp, units) {
    if (units === 0) {
      return (temp - 32) * (5.0 / 9.0);
    }
    return temp;
  }

  convertFromHomeKitTemp(tempC, targetUnits) {
    if (targetUnits === 0) {
      return Math.round((tempC * 9.0 / 5.0) + 32);
    }
    return Math.round(tempC);
  }
  
  async setThermostat(mode, heattemp, cooltemp, fan) {
    try {
      const controlUrl = `http://${this.ip}/control`;
  
      const fallbackHeat = this.lastHeattemp || 70;
      const fallbackCool = this.lastCooltemp || 75;
      const delta = this.setpointdelta || 2;
      const currentMode = mode ?? 0;
  
      let finalHeattemp = (heattemp != null) ? heattemp : fallbackHeat;
      let finalCooltemp = (cooltemp != null) ? cooltemp : fallbackCool;
  
      if (currentMode === 3) {
        if (finalCooltemp <= finalHeattemp + delta) {
          finalCooltemp = finalHeattemp + delta + 1; 
        }
      }
  
      const payload = {
        mode: currentMode,
        heattemp: finalHeattemp,
        cooltemp: finalCooltemp
      };
  
      if (fan != null) {
        payload.fan = fan;
      }
  
      const qs = new URLSearchParams(payload).toString();
  
      await axios.post(controlUrl, qs, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
  
      this.log(`Thermostat updated: mode=${currentMode}, heattemp=${finalHeattemp}, cooltemp=${finalCooltemp}, fan=${fan}`);
      this.pollThermostat();
  
    } catch (err) {
      this.log.error('Error setting thermostat:', err.message);
    }
  }

  async handleTargetHeatingCoolingStateSet(value, callback) {
    this.targetHeatingCoolingState = value;
    const modeMap = {
      [hap.Characteristic.TargetHeatingCoolingState.OFF]: 0,
      [hap.Characteristic.TargetHeatingCoolingState.HEAT]: 1,
      [hap.Characteristic.TargetHeatingCoolingState.COOL]: 2,
      [hap.Characteristic.TargetHeatingCoolingState.AUTO]: 3,
    };

    const venstarMode = modeMap[value];

    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;
      const tempUnits = data.tempunits;
      const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);

      let heattemp = null;
      let cooltemp = null;
      if (venstarMode === 1) heattemp = convertedTemp;
      else if (venstarMode === 2) cooltemp = convertedTemp;
      else if (venstarMode === 3) {
        heattemp = convertedTemp - 1;
        cooltemp = convertedTemp + 1;
      }

      await this.setThermostat(venstarMode, heattemp, cooltemp, null);
      callback(null);
    } catch (err) {
      this.log.error('Error setting target state:', err.message);
      callback(err);
    }
  }

  async handleTargetTemperatureSet(value, callback) {
    this.targetTemperature = value;
    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;
      const tempUnits = data.tempunits;

      const convertedTemp = this.convertFromHomeKitTemp(value, tempUnits);

      let newHeattemp = null;
      let newCooltemp = null;
      if (data.mode === 1) newHeattemp = convertedTemp; 
      else if (data.mode === 2) newCooltemp = convertedTemp;
      else if (data.mode === 3) {
        newHeattemp = convertedTemp - 1;
        newCooltemp = convertedTemp + 1;
      }

      await this.setThermostat(data.mode, newHeattemp, newCooltemp, null);
      callback(null);
    } catch (err) {
      this.log.error('Error setting target temperature:', err.message);
      callback(err);
    }
  }

  handleTemperatureDisplayUnitsSet(value, callback) {
    this.temperatureDisplayUnits = value;
    this.userChangedUnits = true;
    callback(null);
  }

  async handleFanOnSet(value, callback) {
    this.fanOn = value;
    const fanValue = this.fanOn ? 1 : 0;

    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;
      const tempUnits = data.tempunits;
      const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);

      let heattemp = null;
      let cooltemp = null;
      if (data.mode === 1) {
        heattemp = convertedTemp;
      } else if (data.mode === 2) {
        cooltemp = convertedTemp;
      } else if (data.mode === 3) {
        heattemp = convertedTemp - 1;
        cooltemp = convertedTemp + 1;
      }

      await this.setThermostat(data.mode, heattemp, cooltemp, fanValue);
      callback(null);
    } catch (err) {
      this.log.error('Error setting fan state:', err.message);
      callback(err);
    }
  }
}
