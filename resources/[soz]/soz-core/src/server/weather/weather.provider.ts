import { On, Once } from '@public/core/decorators/event';
import axios from 'axios';
import { addMinutes, addSeconds, format } from 'date-fns';

import { Command } from '../../core/decorators/command';
import { Exportable } from '../../core/decorators/exports';
import { Inject } from '../../core/decorators/injectable';
import { Provider } from '../../core/decorators/provider';
import { Tick, TickInterval } from '../../core/decorators/tick';
import { Logger } from '../../core/logger';
import { wait } from '../../core/utils';
import { ClientEvent } from '../../shared/event';
import { Feature, isFeatureEnabled } from '../../shared/features';
import { Forecast, ForecastWithTemperature, Time, Weather } from '../../shared/weather';
import { Monitor } from '../monitor/monitor';
import { Pollution } from '../pollution';
import { Store } from '../store/store';
import { Halloween, SpringAutumn, Winter, WMOWeatherMapping } from './forecast';

const MAX_FORECASTS = 5;
const UPDATE_TIME_INTERVAL = 5;

@Provider()
export class WeatherProvider {
    @Inject(Pollution)
    private pollution: Pollution;

    @Inject('Store')
    private store: Store;

    @Inject(Logger)
    private logger: Logger;

    @Inject(Monitor)
    private monitor: Monitor;

    private shouldUpdateWeather = true;
    private pollutionManagerReady = false;

    // See forecast.ts for the list of available forecasts
    private forecast: Forecast = isFeatureEnabled(Feature.Halloween) ? Halloween : SpringAutumn;
    // See temperature.ts for the list of available temperature ranges,
    // please ensure that the day and night temperature ranges are using the same season
    //private dayTemperatureRange: TemperatureRange = DaySpringTemperature;
    //private nightTemperatureRange: TemperatureRange = NightSpringTemperature;

    private defaultWeather: Weather = isFeatureEnabled(Feature.Halloween) ? 'CLOUDS' : 'OVERCAST';

    private incomingForecasts: ForecastWithTemperature[] = [];

    private stormDeadline = 0; // timestamp
    private timeDelta = 0;
    private timeAdminDelta = 0;

    @Once()
    public async init() {
        if (this.forecast == Winter) {
            this.store.dispatch.global.update({ snow: true });
        }

        try {
            const res = await axios.get('http://worldtimeapi.org/api/timezone/America/Los_Angeles');
            const offset = res.data.utc_offset as string;
            const offsetDate = offset.split(':');
            const localOffset = new Date().getTimezoneOffset() * 60;
            this.timeDelta = parseInt(offsetDate[0]) * 3600 + parseInt(offsetDate[1]) * 60 + localOffset;
        } catch (e) {
            this.logger.error(e);
        }
    }

    private currentTime(): Time {
        const localDate = addSeconds(Date.now(), this.timeDelta);
        const localDateCorrected = addSeconds(localDate, this.timeAdminDelta);

        return {
            hour: localDateCorrected.getHours(),
            minute: localDateCorrected.getMinutes(),
            second: localDateCorrected.getSeconds(),
        };
    }

    @Tick(TickInterval.EVERY_SECOND * UPDATE_TIME_INTERVAL, 'weather:time:advance', true)
    async advanceTime() {
        const time = this.currentTime();

        if (isFeatureEnabled(Feature.Halloween)) {
            if (time.hour >= 2 || time.hour < 1) {
                time.hour = 1;
            }
        }

        TriggerClientEvent(ClientEvent.STATE_UPDATE_TIME, -1, time);
    }

    private formatDate(date: Date) {
        return format(date, "yyyy-MM-dd'T'HH:mm:ss");
    }

    @Tick(TickInterval.EVERY_SECOND, 'weather:next-weather')
    async updateWeather() {
        if (!this.shouldUpdateWeather) {
            return;
        }
        if (!this.pollutionManagerReady) {
            return;
        }

        const localDate = addSeconds(Date.now(), this.timeDelta);
        const endDate = addMinutes(localDate, 15 * MAX_FORECASTS);

        const url =
            `https://api.open-meteo.com/v1/forecast?` +
            `latitude=34.05&longitude=-118.24&minutely_15=weather_code,apparent_temperature&timezone=auto&` +
            `start_minutely_15=${this.formatDate(localDate)}&end_minutely_15=${this.formatDate(endDate)}`;

        try {
            const res = await axios.get(url);

            this.manageForecasts(res.data.minutely_15);
            const currentForecast = this.incomingForecasts[0];

            this.store.dispatch.global.update({ weather: currentForecast.weather });
            this.monitor.publish('weather_update', {}, { weather: currentForecast });

            TriggerClientEvent(ClientEvent.PHONE_APP_WEATHER_UPDATE_FORECASTS, -1);

            const duration = currentForecast.duration;
            await wait(duration);
        } catch (e) {
            this.logger.error(url, e);
            await wait(60_000);
        }
    }

    setWeatherUpdate(update: boolean): void {
        this.shouldUpdateWeather = update;
    }

    @Command('weather', { role: 'admin' })
    setWeatherCommand(source: number, weather = ''): void {
        const weatherString = weather.toUpperCase() as Weather;

        if (!this.forecast[weatherString]) {
            this.logger.error('bad weather ' + weatherString);

            return;
        }

        this.setWeather(weatherString);
    }

    @Command('snow', { role: 'admin' })
    setSnowCommand(source: number, needSnow?: string): void {
        this.store.dispatch.global.update({ snow: needSnow === 'on' || needSnow === 'true' });
    }

    public setStormDeadline(value: number): void {
        this.stormDeadline = value;
        TriggerClientEvent(ClientEvent.PHONE_APP_WEATHER_UPDATE_STORM_ALERT, -1);
    }

    public setWeather(weather: Weather): void {
        this.store.dispatch.global.update({ weather: weather });

        TriggerClientEvent(ClientEvent.PHONE_APP_WEATHER_UPDATE_FORECASTS, -1);

        this.monitor.publish('weather_update', {}, { weather: weather });
    }

    @Command('block_weather', { role: 'admin' })
    blockWeatherCommand(source: number, status?: string): void {
        this.shouldUpdateWeather = status !== 'on' && status !== 'true';
    }

    @Command('time', { role: 'admin' })
    setTime(source: number, hourString?: string, minuteString?: string): void {
        const hour = hourString ? parseInt(hourString, 10) : null;
        const minute = minuteString ? parseInt(minuteString, 10) : 0;

        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return;
        }

        this.timeAdminDelta = 0;
        if (hour != null) {
            const current = this.currentTime();
            this.timeAdminDelta = (hour - current.hour) * 3_600 + (minute - current.minute) * 60;
        }

        TriggerClientEvent(ClientEvent.STATE_UPDATE_TIME, -1, this.currentTime());
    }

    @Command('blackout', { role: 'admin' })
    setBlackout(source: number, status?: string): void {
        this.store.dispatch.global.update({ blackout: status === 'on' || status === 'true' });
    }

    @Command('blackout_level', { role: 'admin' })
    setBlackoutLevel(source: number, level?: string): void {
        if (!level || level === 'default') {
            this.store.dispatch.global.update({
                blackoutLevel: 0,
                blackoutOverride: false,
            });
        } else {
            this.store.dispatch.global.update({
                blackoutLevel: parseInt(level, 10) || 0,
                blackoutOverride: true,
            });
        }
    }

    @Exportable('getWeatherForecasts')
    getWeatherForecasts(): ForecastWithTemperature[] {
        return this.incomingForecasts;
    }

    @Exportable('getStormAlert')
    getStormAlert(): number {
        return this.stormDeadline;
    }

    private manageForecasts(data) {
        this.incomingForecasts = [];
        for (let i = 0; i < data.time.length; i++) {
            if (this.incomingForecasts.length > MAX_FORECASTS) {
                return;
            }

            this.incomingForecasts.push({
                duration: Math.round((Math.random() * 10 + 10) * 60 * 1000),
                temperature: data.apparent_temperature[i],
                weather: WMOWeatherMapping[data.weather_code[i]] || this.defaultWeather,
            });
        }
    }

    @On('soz-upw:server:onPollutionManagerReady', true)
    public onPollutionManagerReady() {
        this.pollutionManagerReady = true;
    }

    @Command('rain', { role: 'admin' })
    setRain(source: number, rain: number): void {
        this.store.dispatch.global.update({ rain: rain });
    }

    @Command('halloween', { role: 'admin' })
    setTimecycleMod(source: number, value: string): void {
        if (value) {
            if (value == 'full') {
                value = 'HalloweenFullRed';
            } else if (value == 'light') {
                value = 'HalloweenLightRed';
            } else if (value == 'clear') {
                value = 'HalloweenClearRed';
            } else if (value == 'off') {
                value = '';
            } else {
                this.logger.error('Invalid value ' + value + ', expect full or light or clear or off');
            }
        }
        this.store.dispatch.global.update({ halloween: value });
    }
}
