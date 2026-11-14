import type { Terrain } from './mission';

export const regionAsset = (region: NonNullable<Terrain['region']>, name: string) =>
  `${import.meta.env.BASE_URL}${region}/${name}`;

export const regionLabels = { gale: 'Bradbury–Yellowknife', boxwork: 'Mount Sharp Boxwork' };
