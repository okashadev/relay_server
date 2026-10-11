export const pairKey = (a: string, b: string): string =>
  a < b ? `${a}:${b}` : `${b}:${a}`;
