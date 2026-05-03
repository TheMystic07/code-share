import { webcrypto } from "node:crypto";

import * as x509 from "@peculiar/x509";
const { subtle } = webcrypto;

export interface EphemeralCA {
  certPem: string;
  keyPem: string;
  /** Raw DER bytes of the cert — used by http-mitm-proxy */
  certDer: Buffer;
}

export async function generateEphemeralCA(): Promise<EphemeralCA> {
  // Generate an EC key pair for the CA
  const alg: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
  const keyPair = (await subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 24 * 60 * 60 * 1000); // 24h validity

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    name: "CN=claude-share ephemeral CA",
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys: keyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, 10, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });

  const certPem = cert.toString("pem");
  const certDer = Buffer.from(cert.rawData);

  // Export private key to PKCS8 PEM
  const pkcs8 = await subtle.exportKey("pkcs8", keyPair.privateKey);
  const keyPem = [
    "-----BEGIN PRIVATE KEY-----",
    Buffer.from(pkcs8)
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n"),
    "-----END PRIVATE KEY-----",
  ].join("\n");

  return { certPem, keyPem, certDer };
}
