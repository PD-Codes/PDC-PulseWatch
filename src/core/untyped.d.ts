// These optional packages ship no type declarations; only the parts the runners use are described here.
declare module 'gamedig' {
  export class GameDig {
    static query(options: Record<string, unknown>): Promise<Record<string, any>>;
  }
}
declare module 'oracledb' {
  const oracledb: { getConnection(options: Record<string, unknown>): Promise<unknown> };
  export default oracledb;
}
