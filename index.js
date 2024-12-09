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

    this.api.on('didFinishLaunching', () => {
      this.log('didFinishLaunching');

      for (const thermostatConfig of this.thermostats) {
        const uuid = this.api.hap.uuid.generate('homebridge:venstar:' + thermostatConfig.ip);
        const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

        if (existingAccessory) {
          this.log(`Updating existing accessory: ${thermostatConfig.name}`);
          existingAccessory.context.config = thermostatConfig;
          if (!existingAccessory.context.initialized) {
            new VenstarThermostatAccessory(this.log, thermostatConfig, this.api, existingAccessory);
            existingAccessory.context.initialized = true;
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
    this.log(`Configuring cached accessory: ${accessory.displayName}`);
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

    // Add these for AUTO mode thresholds
    this.heatingSetpointC = 20;
    this.coolingSetpointC = 24;
    this.deviceUnits = 1; // assume Celsius until polling

    this.accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, "Venstar")
      .setCharacteristic(hap.Characteristic.Model, "Explorer Mini");

    this.thermostatService = this.accessory.getService(hap.Service.Thermostat)
      || this.accessory.addService(hap.Service.Thermostat, this.name);

    this.fanService = this.accessory.getService(hap.Service.Fan)
      || this.accessory.addService(hap.Service.Fan, `${this.name} Fan`);

    // Original handlers
    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', (callback) => callback(null, this.currentHeatingCoolingState));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          hap.Characteristic.TargetHeatingCoolingState.OFF,
          hap.Characteristic.TargetHeatingCoolingState.HEAT,
          hap.Characteristic.TargetHeatingCoolingState.COOL,
          hap.Characteristic.TargetHeatingCoolingState.AUTO
        ]
      })
      .on('get', (callback) => callback(null, this.targetHeatingCoolingState))
      .on('set', this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', (callback) => callback(null, this.currentTemperature));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', (callback) => {
        // Return TargetTemperature as before for non-auto modes
        callback(null, this.targetTemperature);
      })
      .on('set', this.handleTargetTemperatureSet.bind(this))
      .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 });

    this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .on('get', (callback) => callback(null, this.temperatureDisplayUnits))
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

    // Add Heating and Cooling threshold characteristics for AUTO mode
    this.thermostatService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .on('get', (callback) => callback(null, this.heatingSetpointC))
      .on('set', this.handleHeatingThresholdTemperatureSet.bind(this))
      .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 });

    this.thermostatService.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature)
      .on('get', (callback) => callback(null, this.coolingSetpointC))
      .on('set', this.handleCoolingThresholdTemperatureSet.bind(this))
      .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 });

    this.pollThermostat();
    this.pollInterval = setInterval(() => this.pollThermostat(), 60 * 1000);
  }

  async pollThermostat() {
    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;

      const modeMap = {
        0: hap.Characteristic.TargetHeatingCoolingState.OFF,
        1: hap.Characteristic.TargetHeatingCoolingState.HEAT,
        2: hap.Characteristic.TargetHeatingCoolingState.COOL,
        3: hap.Characteristic.TargetHeatingCoolingState.AUTO,
      };

      this.deviceUnits = data.tempunits; 
      this.currentTemperature = this.convertToHomeKitTemp(data.spacetemp, data.tempunits);
      this.targetHeatingCoolingState = modeMap[data.mode] || hap.Characteristic.TargetHeatingCoolingState.OFF;
      this.currentHeatingCoolingState = this.determineCurrentState(data.state);

      if (!this.userChangedUnits) {
        this.temperatureDisplayUnits = (data.tempunits === 0)
          ? hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
      }

      this.fanOn = (data.fan === 1);

      if (data.mode === 3) {
        // AUTO: use thresholds from device
        this.heatingSetpointC = this.convertToHomeKitTemp(data.heattemp, data.tempunits);
        this.coolingSetpointC = this.convertToHomeKitTemp(data.cooltemp, data.tempunits);

        // Update thresholds
        this.thermostatService.updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, this.heatingSetpointC);
        this.thermostatService.updateCharacteristic(hap.Characteristic.CoolingThresholdTemperature, this.coolingSetpointC);
      } else {
        // Non-auto: update target temp as before
        this.targetTemperature = this.determineTargetTemperature(data);
        this.thermostatService.updateCharacteristic(hap.Characteristic.TargetTemperature, this.targetTemperature);
      }

      this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentTemperature, this.currentTemperature);
      this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentHeatingCoolingState);
      this.thermostatService.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState);
      this.thermostatService.updateCharacteristic(hap.Characteristic.TemperatureDisplayUnits, this.temperatureDisplayUnits);
      this.fanService.updateCharacteristic(hap.Characteristic.On, this.fanOn);

    } catch (err) {
      this.log.error('Error polling thermostat:', err.message);
    }
  }

  determineTargetTemperature(data) {
    // Same original logic for non-auto modes
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

      const qs = new URLSearchParams({
        mode: mode,
        heattemp: heattemp ?? 70,
        cooltemp: cooltemp ?? 75,
        ...(fan != null ? { fan: fan } : {})
      }).toString();

      await axios.post(controlUrl, qs, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      this.log(`Thermostat updated: mode=${mode}, heattemp=${heattemp}, cooltemp=${cooltemp}, fan=${fan}`);
      this.pollThermostat();

    } catch (err) {
      this.log.error('Error setting thermostat:', err.message);
    }
  }

  // AUTO threshold handlers
  handleHeatingThresholdTemperatureSet(value, callback) {
    this.heatingSetpointC = value;
    if (this.targetHeatingCoolingState === hap.Characteristic.TargetHeatingCoolingState.AUTO) {
      const heattemp = this.convertFromHomeKitTemp(this.heatingSetpointC, this.deviceUnits);
      const cooltemp = this.convertFromHomeKitTemp(this.coolingSetpointC, this.deviceUnits);
      this.setThermostat(3, heattemp, cooltemp, null);
    }
    callback(null);
  }

  handleCoolingThresholdTemperatureSet(value, callback) {
    this.coolingSetpointC = value;
    if (this.targetHeatingCoolingState === hap.Characteristic.TargetHeatingCoolingState.AUTO) {
      const heattemp = this.convertFromHomeKitTemp(this.heatingSetpointC, this.deviceUnits);
      const cooltemp = this.convertFromHomeKitTemp(this.coolingSetpointC, this.deviceUnits);
      this.setThermostat(3, heattemp, cooltemp, null);
    }
    callback(null);
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

      let heattemp = null;
      let cooltemp = null;
      if (venstarMode === 1) {
        const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);
        heattemp = convertedTemp;
      } else if (venstarMode === 2) {
        const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);
        cooltemp = convertedTemp;
      } else if (venstarMode === 3) {
        // On switching to AUTO, use the current thresholds
        const heatC = this.heatingSetpointC;
        const coolC = this.coolingSetpointC;
        heattemp = this.convertFromHomeKitTemp(heatC, tempUnits);
        cooltemp = this.convertFromHomeKitTemp(coolC, tempUnits);
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
        // In AUTO, ignore TargetTemperature sets (only use thresholds)
      }

      if (data.mode !== 3) {
        await this.setThermostat(data.mode, newHeattemp, newCooltemp, null);
      }
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
        // In AUTO mode, just pick something around targetTemp if needed
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
