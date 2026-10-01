import { describe, expect, it } from 'vitest';

import {
  describeCondition,
  formatPressure,
  formatTemperatureC,
  formatWindSpeed,
  windDirectionText,
} from './weather';

describe('formatTemperatureC', () => {
  it('muotoilee lämpötilan suomalaisella desimaalierottimella', () => {
    expect(formatTemperatureC(12.7)).toBe('12,7 °C');
    expect(formatTemperatureC(-3.4)).toBe('-3,4 °C');
    expect(formatTemperatureC(12)).toBe('12,0 °C');
  });

  it('palauttaa tyhjän puuttuvalle tai kelvottomalle arvolle (ei nollaa)', () => {
    expect(formatTemperatureC(null)).toBe('');
    expect(formatTemperatureC(undefined)).toBe('');
    expect(formatTemperatureC(Number.NaN)).toBe('');
  });
});

describe('formatWindSpeed', () => {
  it('muotoilee tuulen nopeuden', () => {
    expect(formatWindSpeed(1.6)).toBe('1,6 m/s');
    expect(formatWindSpeed(0)).toBe('0,0 m/s');
  });

  it('palauttaa tyhjän puuttuvalle arvolle', () => {
    expect(formatWindSpeed(null)).toBe('');
  });
});

describe('formatPressure', () => {
  it('muotoilee ilmanpaineen', () => {
    expect(formatPressure(1036.4)).toBe('1036,4 hPa');
    expect(formatPressure(null)).toBe('');
  });
});

describe('windDirectionText', () => {
  it('kertoo suunnan, josta tuuli tulee (meteorologinen käytäntö)', () => {
    expect(windDirectionText(0)).toBe('pohjoisesta');
    expect(windDirectionText(45)).toBe('koillisesta');
    expect(windDirectionText(90)).toBe('idästä');
    expect(windDirectionText(180)).toBe('etelästä');
    expect(windDirectionText(270)).toBe('lännestä');
  });

  it('osuu oikeaan lohkoon rajojen molemmin puolin', () => {
    expect(windDirectionText(22)).toBe('pohjoisesta');
    expect(windDirectionText(23)).toBe('koillisesta');
    expect(windDirectionText(350)).toBe('pohjoisesta');
    expect(windDirectionText(360)).toBe('pohjoisesta');
  });

  it('palauttaa tyhjän puuttuvalle arvolle', () => {
    expect(windDirectionText(null)).toBe('');
    expect(windDirectionText(Number.NaN)).toBe('');
  });
});

describe('describeCondition', () => {
  it('tulkitsee sateen (ja lumen pakkasella) ennen pilvisyyttä', () => {
    expect(
      describeCondition({ precipitation1hMm: 0.4, temperatureC: 5, cloudCoverOktas: 8 }),
    ).toEqual({
      emoji: '🌧️',
      label: 'Sadetta',
    });
    expect(
      describeCondition({ precipitation1hMm: 1.2, temperatureC: -2, cloudCoverOktas: 8 }),
    ).toEqual({
      emoji: '🌨️',
      label: 'Lumisadetta',
    });
  });

  it('tulkitsee pilvisyyden oktat', () => {
    expect(describeCondition({ cloudCoverOktas: 8 })?.label).toBe('Pilvistä');
    expect(describeCondition({ cloudCoverOktas: 4 })?.label).toBe('Puolipilvistä');
    expect(describeCondition({ cloudCoverOktas: 1 })?.label).toBe('Melko selkeää');
    expect(describeCondition({ cloudCoverOktas: 0 })?.label).toBe('Selkeää');
  });

  it('ei keksi kuvausta, kun ei ole sadetta eikä pilvisyystietoa', () => {
    expect(describeCondition({ precipitation1hMm: null, cloudCoverOktas: null })).toBeNull();
    expect(describeCondition({})).toBeNull();
  });
});
