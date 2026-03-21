declare module 'solar-calculator' {
  export function century(date: Date): number;
  export function declination(t: number): number;
  export function equationOfTime(t: number): number;
}
