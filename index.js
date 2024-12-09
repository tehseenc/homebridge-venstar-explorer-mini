'use strict';

const axios = require('axios');
let hap; // Will hold the HAP instance from Homebridge

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

    if (!this.thermostats.length) {
      this.log.warn('No thermostats configured.');
    }

    // When homebridge finishes loading, register accessories.
    this.api.on('didFinishLaunching', () => {
      for (const thermostatConfig of this.thermostats) {
        new VenstarThermostatAccessory(
          this.log,
          thermostatConfig,
          this.api
        );
      }
    });
  }
}

class VenstarThermostatAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.name = config.name || "Venstar Thermostat";
    this.ip = config.ip;

    this.thermostatService = new hap.Service.Thermostat(this.name);
    this.fanService = new hap.Service.Fan(`${this.name} Fan`);

    // Default internal states
    this.currentTemperature = 20; // Celsius
    this.targetTemperature = 22; // Celsius
    this.currentHeatingCoolingState = hap.Characteristic.CurrentHeatingCoolingState.OFF;
    this.targetHeatingCoolingState = hap.Characteristic.TargetHeatingCoolingState.AUTO;
    this.temperatureDisplayUnits = hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.userChangedUnits = false; // tracks if user manually changed display units
    this.fanOn = false; // true if fan forced on, false if auto

    // Thermostat characteristic handlers
    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          hap.Characteristic.TargetHeatingCoolingState.OFF,
          hap.Characteristic.TargetHeatingCoolingState.HEAT,
          hap.Characteristic.TargetHeatingCoolingState.COOL,
          hap.Characteristic.TargetHeatingCoolingState.AUTO
        ]
      })
      .on('get', this.handleTargetHeatingCoolingStateGet.bind(this))
      .on('set', this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', this.handleCurrentTemperatureGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', this.handleTargetTemperatureGet.bind(this))
      .on('set', this.handleTargetTemperatureSet.bind(this))
      .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 });

    this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .on('get', this.handleTemperatureDisplayUnitsGet.bind(this))
      .on('set', this.handleTemperatureDisplayUnitsSet.bind(this));

    // Fan characteristic handlers
    this.fanService.getCharacteristic(hap.Characteristic.On)
      .on('get', this.handleFanOnGet.bind(this))
      .on('set', this.handleFanOnSet.bind(this));

    // Poll the thermostat periodically for updates
    this.pollThermostat();
    setInterval(() => {
      this.pollThermostat();
    }, 60 * 1000); // Poll every 60 seconds

    // Register accessory with Homebridge
    this.api.publishExternalAccessories("VenstarExplorerMini", [this.getAccessory()]);
  }

  getAccessory() {
    const uuid = this.api.hap.uuid.generate('homebridge:venstar:' + this.ip);
    const accessory = new this.api.platformAccessory(this.name, uuid);
    accessory.addService(this.thermostatService);
    accessory.addService(this.fanService);
    return accessory;
  }

  async pollThermostat() {
    try {
      const infoUrl = `http://${this.ip}/query/info`;
      const response = await axios.get(infoUrl);
      const data = response.data;

      // data fields of interest: mode, spacetemp, heattemp, cooltemp, tempunits, state, fan
      // tempunits: 0=F,1=C
      // fan: 0=auto,1=on

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

      // Sync units if user hasn't changed them
      if (!this.userChangedUnits) {
        this.temperatureDisplayUnits = (data.tempunits === 0)
          ? hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
          : hap.Characteristic.TemperatureDisplayUnits.CELSIUS;
      }

      // Fan state
      this.fanOn = (data.fan === 1);

      // Update HomeKit
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
    // mode: 0=off,1=heat,2=cool,3=auto
    // For AUTO, use midpoint of heattemp and cooltemp.
    // For HEAT, use heattemp. For COOL, use cooltemp. OFF uses spacetemp.
    if (data.mode === 3) { // AUTO
      const avg = (data.heattemp + data.cooltemp) / 2;
      return this.convertToHomeKitTemp(avg, data.tempunits);
    }

    if (data.mode === 1) { // HEAT
      return this.convertToHomeKitTemp(data.heattemp, data.tempunits);
    }

    if (data.mode === 2) { // COOL
      return this.convertToHomeKitTemp(data.cooltemp, data.tempunits);
    }

    // OFF mode
    return this.convertToHomeKitTemp(data.spacetemp, data.tempunits);
  }

  determineCurrentState(state) {
    // state: 0=idle,1=heating,2=cooling
    if (state === 1) {
      return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
    } else if (state === 2) {
      return hap.Characteristic.CurrentHeatingCoolingState.COOL;
    } else {
      return hap.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  convertToHomeKitTemp(temp, units) {
    // If units=0 (F), convert to C.
    if (units === 0) {
      return (temp - 32) * (5.0 / 9.0);
    }
    return temp;
  }

  convertFromHomeKitTemp(tempC, targetUnits) {
    // Convert from Celsius to device units
    if (targetUnits === 0) {
      // Fahrenheit
      return Math.round((tempC * 9.0 / 5.0) + 32);
    } else {
      // Celsius
      return Math.round(tempC);
    }
  }

  async setThermostat(mode, heattemp, cooltemp, fan) {
    try {
      const controlUrl = `http://${this.ip}/control`;
      const payload = { mode };

      if (heattemp != null) payload.heattemp = heattemp;
      if (cooltemp != null) payload.cooltemp = cooltemp;
      if (fan != null) payload.fan = fan;

      await axios.post(controlUrl, payload);
      this.log(`Thermostat updated: mode=${mode}, heattemp=${heattemp}, cooltemp=${cooltemp}, fan=${fan}`);
      this.pollThermostat(); // refresh
    } catch (err) {
      this.log.error('Error setting thermostat:', err.message);
    }
  }

  // --- Thermostat Characteristic Handlers ---

  handleCurrentHeatingCoolingStateGet(callback) {
    callback(null, this.currentHeatingCoolingState);
  }

  handleTargetHeatingCoolingStateGet(callback) {
    callback(null, this.targetHeatingCoolingState);
  }

  async handleTargetHeatingCoolingStateSet(value, callback) {
    this.targetHeatingCoolingState = value;

    // Map HomeKit states to Venstar modes
    const modeMap = {
      [hap.Characteristic.TargetHeatingCoolingState.OFF]: 0,
      [hap.Characteristic.TargetHeatingCoolingState.HEAT]: 1,
      [hap.Characteristic.TargetHeatingCoolingState.COOL]: 2,
      [hap.Characteristic.TargetHeatingCoolingState.AUTO]: 3,
    };

    const venstarMode = modeMap[value];

    let data;
    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      data = response.data;
    } catch (err) {
      this.log.error('Error reading thermostat info:', err.message);
      return callback(err);
    }

    const tempUnits = data.tempunits;
    const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);

    let heattemp = null;
    let cooltemp = null;
    if (venstarMode === 1) {
      // Heat mode
      heattemp = convertedTemp;
    } else if (venstarMode === 2) {
      // Cool mode
      cooltemp = convertedTemp;
    } else if (venstarMode === 3) {
      // Auto mode: set a band around target
      heattemp = convertedTemp - 1;
      cooltemp = convertedTemp + 1;
    }

    await this.setThermostat(venstarMode, heattemp, cooltemp, null);

    callback(null);
  }

  handleCurrentTemperatureGet(callback) {
    callback(null, this.currentTemperature);
  }

  handleTargetTemperatureGet(callback) {
    callback(null, this.targetTemperature);
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

      // mode: 0=off,1=heat,2=cool,3=auto
      if (data.mode === 1) {
        // Heat
        newHeattemp = convertedTemp;
      } else if (data.mode === 2) {
        // Cool
        newCooltemp = convertedTemp;
      } else if (data.mode === 3) {
        // Auto
        newHeattemp = convertedTemp - 1;
        newCooltemp = convertedTemp + 1;
      }

      await this.setThermostat(data.mode, newHeattemp, newCooltemp, null);
    } catch (err) {
      this.log.error('Error setting target temperature:', err.message);
      return callback(err);
    }

    callback(null);
  }

  handleTemperatureDisplayUnitsGet(callback) {
    callback(null, this.temperatureDisplayUnits);
  }

  handleTemperatureDisplayUnitsSet(value, callback) {
    this.temperatureDisplayUnits = value;
    this.userChangedUnits = true;
    callback(null);
  }

  // --- Fan Characteristic Handlers ---

  async handleFanOnGet(callback) {
    try {
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;
      // fan: 0=auto,1=on
      this.fanOn = (data.fan === 1);
      callback(null, this.fanOn);
    } catch (err) {
      this.log.error('Error getting fan state:', err.message);
      callback(err);
    }
  }

  async handleFanOnSet(value, callback) {
    // value: true (fan on), false (auto)
    this.fanOn = value;
    const fanValue = this.fanOn ? 1 : 0;

    try {
      // Get current mode & setpoints to avoid overwriting them unintentionally
      const response = await axios.get(`http://${this.ip}/query/info`);
      const data = response.data;
      const tempUnits = data.tempunits;

      // Convert current targetTemperature to device units:
      const convertedTemp = this.convertFromHomeKitTemp(this.targetTemperature, tempUnits);

      let heattemp = null;
      let cooltemp = null;

      // mode: 0=off,1=heat,2=cool,3=auto
      if (data.mode === 1) {
        heattemp = convertedTemp;
      } else if (data.mode === 2) {
        cooltemp = convertedTemp;
      } else if (data.mode === 3) {
        // auto band
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
