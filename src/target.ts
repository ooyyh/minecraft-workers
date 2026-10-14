export type ServerTarget = { hostname: string; port: number };
export const DEFAULT_TARGET: ServerTarget = { hostname: "play.simpfun.cn", port: 32101 };

export function serverTarget(input: Record<string, unknown>): ServerTarget {
  if (typeof input.hostname !== "string") throw Error("请输入服务器域名或 IP 地址");
  const hostname = input.hostname.trim().toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
  const port = input.port;
  if (!hostname || hostname.length > 253 || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Error("请输入有效的服务器地址和 1–65535 端口");
  }
  if (/[^a-z0-9.:-]/.test(hostname) || hostname.includes("..") || hostname.includes("/") || hostname.includes("@")) {
    throw Error("地址只支持域名、IPv4 或 IPv6，不要包含协议、路径或账号");
  }
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) {
    throw Error("服务器必须是公网地址");
  }
  if (hostname.includes(":") && /^(::1|::|fc|fd|fe[89ab]|ff)/.test(hostname)) {
    throw Error("服务器必须是公网地址");
  }
  if (!hostname.includes(":")) {
    const labels = hostname.split(".");
    const ipv4 = labels.length === 4 && labels.every(label => /^\d+$/.test(label) && Number(label) <= 255);
    if (!ipv4 && (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw Error("请输入有效的公网域名或 IP");
  }
  return { hostname, port };
}
