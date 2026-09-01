import net from "node:net";

import forge from "node-forge";

export interface ServerCert {
  certPem: string;
  keyPem: string;
}

export interface CertHosts {
  /** DNS names receivers may connect with (bore host, custom domain, …) */
  hostnames: string[];
  /** IP addresses receivers may connect with (LAN IP, public IP, …) */
  ips: string[];
}

/** Generates a TLS server cert for the API port, signed by the MITM CA. */
export async function generateServerCert(
  caCertPem: string,
  caKeyPem: string,
  hosts: CertHosts,
): Promise<ServerCert> {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  const keys = await new Promise<forge.pki.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  cert.setSubject([{ name: "commonName", value: "claude-share-api" }]);
  cert.setIssuer(caCert.subject.attributes);

  const dns = new Set<string>(["localhost"]);
  const ips = new Set<string>(["127.0.0.1"]);
  for (const h of hosts.hostnames) {
    if (!h) continue;
    if (net.isIP(h)) ips.add(h);
    else dns.add(h);
  }
  for (const ip of hosts.ips) if (ip && net.isIP(ip)) ips.add(ip);

  const altNames: { type: number; value?: string; ip?: string }[] = [
    ...[...dns].map((value) => ({ type: 2, value })),
    ...[...ips].map((ip) => ({ type: 7, ip })),
  ];

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
