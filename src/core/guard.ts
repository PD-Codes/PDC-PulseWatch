import dns from 'node:dns';
import net from 'node:net';
import { CheckError } from './types';

export interface GuardConfig {
  /** allow-private: internal hosts may be monitored (default). public-only: block private/reserved ranges. */
  mode: 'allow-private' | 'public-only';
  /** CIDRs or single IPs that are always allowed (override public-only). */
  allow: string[];
  /** CIDRs or single IPs that are always blocked (checked first). */
  deny: string[];
}

export const DEFAULT_DENY = ['169.254.169.254/32', 'fd00:ec2::254/128'];

const PRIVATE: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

function toList(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bits] = entry.split('/');
    const family = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (!net.isIP(addr)) throw new Error(`Invalid IP/CIDR in SSRF list: ${entry}`);
    if (bits === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, Number(bits), family);
  }
  return list;
}

/** Strip the IPv4-mapped IPv6 prefix so ::ffff:10.0.0.1 is judged as 10.0.0.1. */
function normalize(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export class NetGuard {
  private allow!: net.BlockList;
  private deny!: net.BlockList;
  private priv!: net.BlockList;

  constructor(public config: GuardConfig = { mode: 'allow-private', allow: [], deny: DEFAULT_DENY }) {
    this.update(config);
  }

  /** Swap the rules at runtime. Throws (and keeps the old rules) when a list entry is invalid. */
  update(config: GuardConfig): void {
    const allow = toList(config.allow);
    const deny = toList(config.deny);
    const priv = new net.BlockList();
    for (const [a, b, f] of PRIVATE) priv.addSubnet(a, b, f);
    this.allow = allow; this.deny = deny; this.priv = priv; this.config = config;
  }

  /** Returns a reason string when the address must not be contacted, otherwise null. */
  check(address: string): string | null {
    const ip = normalize(address);
    const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    if (this.deny.check(ip, family)) return `address ${ip} is on the deny list`;
    if (this.config.mode === 'public-only' && !this.allow.check(ip, family) && this.priv.check(ip, family)) {
      return `address ${ip} is private/reserved and the guard runs in public-only mode`;
    }
    return null;
  }

  /** Throws a "blocked" CheckError when a literal IP is not allowed. Hostnames are checked at connect time via `lookup`. */
  assertLiteral(host: string): void {
    if (net.isIP(host)) this.assertAddress(host);
  }

  assertAddress(address: string): void {
    const reason = this.check(address);
    if (reason) throw new CheckError('blocked', `Blocked by SSRF guard: ${reason}`);
  }

  /** Resolve a host and make sure every answer is allowed. Returns the addresses. */
  async resolve(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
    if (net.isIP(host)) {
      this.assertAddress(host);
      return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
    }
    const answers = await dns.promises.lookup(host, { all: true });
    if (!answers.length) throw Object.assign(new Error('no addresses'), { code: 'ENOTFOUND' });
    for (const a of answers) this.assertAddress(a.address);
    return answers as { address: string; family: 4 | 6 }[];
  }

  /** Drop-in for the `lookup` socket option: validates every connect, including redirects and re-connects. */
  lookup = (
    hostname: string,
    options: dns.LookupOptions | number | undefined,
    cb: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
  ): void => {
    const opts = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
    dns.lookup(hostname, { ...opts, all: true }, (err, answers) => {
      if (err) return cb(err);
      const list = answers as dns.LookupAddress[];
      for (const a of list) {
        const reason = this.check(a.address);
        if (reason) {
          const e: NodeJS.ErrnoException = new Error(`Blocked by SSRF guard: ${reason}`);
          e.code = 'PW_BLOCKED';
          return cb(e);
        }
      }
      if (opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}
