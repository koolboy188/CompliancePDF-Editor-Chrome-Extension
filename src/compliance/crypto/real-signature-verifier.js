let forgePromise;
let rootCAsPromise;

export async function verifyPdfDigitalSignature(pdfBytes) {
  const forge = await loadForge();
  const pdfBuffer = preparePdfBytes(pdfBytes);
  const pdfLatin1 = bytesToLatin1(pdfBuffer);
  const subFilter = getSubFilter(pdfLatin1);

  if (!subFilter) {
    return {
      available: false,
      verified: false,
      reason: "not_signed",
      signatures: []
    };
  }

  if (!SUPPORTED_SUBFILTERS.has(subFilter)) {
    return {
      available: true,
      verified: false,
      reason: "unsupported_subfilter",
      subFilter,
      signatures: []
    };
  }

  try {
    const rootCAs = await loadRootCAs();
    const { signatureBlocks, signatureMeta } = extractSignatureBlocks(pdfBuffer, pdfLatin1);
    const signatures = signatureBlocks.map((block, index) =>
      verifySignatureBlock(forge, block, signatureMeta[index], rootCAs)
    );

    return {
      available: signatureBlocks.length > 0,
      verified: signatures.length > 0 && signatures.every((item) => item.verified),
      authenticity: signatures.length > 0 && signatures.every((item) => item.authenticity),
      integrity: signatures.length > 0 && signatures.every((item) => item.integrity),
      expired: signatures.some((item) => item.expired),
      subFilter,
      signatures
    };
  } catch (error) {
    return {
      available: true,
      verified: false,
      reason: "verification_error",
      subFilter,
      message: error?.message ?? "Unknown signature verification error",
      signatures: []
    };
  }
}

const SUPPORTED_SUBFILTERS = new Set([
  "adbe.pkcs7.detached",
  "etsi.cades.detached"
]);

async function loadForge() {
  if (!forgePromise) {
    forgePromise = new Promise((resolve, reject) => {
      if (globalThis.forge) {
        resolve(globalThis.forge);
        return;
      }
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("node_modules/node-forge/dist/forge.min.js");
      script.async = true;
      script.onload = () => {
        if (globalThis.forge) {
          resolve(globalThis.forge);
        } else {
          reject(new Error("node-forge failed to initialize"));
        }
      };
      script.onerror = () => reject(new Error("Unable to load node-forge bundle"));
      document.head.append(script);
    });
  }
  return forgePromise;
}

async function loadRootCAs() {
  if (!rootCAsPromise) {
    rootCAsPromise = fetch(chrome.runtime.getURL("node_modules/@ninja-labs/verify-pdf/lib/helpers/rootCAs.json"))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Cannot load root CA bundle (${response.status})`);
        }
        return response.json();
      });
  }
  return rootCAsPromise;
}

function preparePdfBytes(pdfBytes) {
  if (pdfBytes instanceof Uint8Array) {
    return pdfBytes;
  }
  if (pdfBytes instanceof ArrayBuffer) {
    return new Uint8Array(pdfBytes);
  }
  throw new Error("PDF expected as ArrayBuffer or Uint8Array");
}

function bytesToLatin1(bytes) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

function getSubFilter(pdfLatin1) {
  const matches = pdfLatin1.match(/\/SubFilter\s*\/([\w.]+)/);
  return Array.isArray(matches) ? String(matches[1] ?? "").trim().toLowerCase() : "";
}

function extractSignatureBlocks(pdfBytes, pdfLatin1) {
  const byteRanges = getByteRanges(pdfLatin1);
  const lastRange = byteRanges[byteRanges.length - 1];
  const endOfByteRange = lastRange[2] + lastRange[3];
  if (pdfBytes.length > endOfByteRange) {
    throw new Error("Failed byte range verification");
  }

  const signatureBlocks = byteRanges.map((byteRange) => {
    const signedData = concatUint8Arrays([
      pdfBytes.slice(byteRange[0], byteRange[0] + byteRange[1]),
      pdfBytes.slice(byteRange[2], byteRange[2] + byteRange[3])
    ]);
    const hexStart = byteRange[0] + byteRange[1] + 1;
    const hexEnd = byteRange[2];
    const signatureHex = pdfLatin1.slice(hexStart, hexEnd).replace(/[<>\s]/g, "");
    return {
      signatureBinary: hexToLatin1(signatureHex),
      signedDataBinary: bytesToLatin1(signedData),
      signedDataText: bytesToUtf8OrLatin1(signedData)
    };
  });

  return {
    signatureBlocks,
    signatureMeta: signatureBlocks.map((block) => getSignatureMeta(block.signedDataText))
  };
}

function getByteRanges(pdfLatin1) {
  const matches = pdfLatin1.match(/\/ByteRange\s*\[[^\]]+\]/g);
  if (!matches?.length) {
    throw new Error("Failed to locate ByteRange");
  }
  return matches.map((entry) => {
    const values = entry.match(/\d+/g)?.map(Number) ?? [];
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid ByteRange");
    }
    return values;
  });
}

function concatUint8Arrays(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function hexToLatin1(hex) {
  let output = "";
  for (let index = 0; index < hex.length; index += 2) {
    const value = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(value)) {
      continue;
    }
    output += String.fromCharCode(value);
  }
  return output;
}

function bytesToUtf8OrLatin1(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) {
    return bytesToLatin1(bytes);
  }
}

function getSignatureMeta(sourceText) {
  return {
    reason: getMetaMatch("Reason", sourceText),
    contactInfo: getMetaMatch("ContactInfo", sourceText),
    location: getMetaMatch("Location", sourceText),
    name: getMetaMatch("Name", sourceText)
  };
}

function getMetaMatch(key, sourceText) {
  const regex = new RegExp(`/${key}\\s*\\(([^)]*)\\)`, "g");
  const matches = [...sourceText.matchAll(regex)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function verifySignatureBlock(forge, block, signatureMeta, rootCAs) {
  const message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(block.signatureBinary));
  const certificates = Array.from(message.certificates ?? []);
  const signerInfo = message.rawCapture ?? {};
  const digestAlgorithmOid = forge.asn1.derToOid(signerInfo.digestAlgorithm);
  const hashAlgorithm = String(forge.pki.oids[digestAlgorithmOid] ?? "").toLowerCase();
  if (!hashAlgorithm || !forge.md[hashAlgorithm]) {
    throw new Error(`Unsupported digest algorithm: ${digestAlgorithmOid}`);
  }

  const authenticatedAttributes = signerInfo.authenticatedAttributes ?? [];
  const set = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    authenticatedAttributes
  );
  const certificateChain = sortCertificateChain(certificates);
  const clientCertificate = certificateChain[0];
  if (!clientCertificate) {
    throw new Error("Client certificate not found");
  }

  const authenticatedDigest = forge.md[hashAlgorithm]
    .create()
    .update(forge.asn1.toDer(set).data)
    .digest()
    .getBytes();
  const authenticatedAttributesValid = clientCertificate.publicKey.verify(
    authenticatedDigest,
    signerInfo.signature
  );

  const messageDigestOid = forge.pki.oids.messageDigest;
  const messageDigestAttribute = authenticatedAttributes.find(
    (attr) => forge.asn1.derToOid(attr.value[0].value) === messageDigestOid
  );
  const signedDigest = messageDigestAttribute?.value?.[1]?.value?.[0]?.value ?? "";
  const dataDigest = forge.md[hashAlgorithm]
    .create()
    .update(block.signedDataBinary)
    .digest()
    .getBytes();

  const integrity = authenticatedAttributesValid && signedDigest === dataDigest;
  const authenticity = verifyCertificateChain(forge, certificateChain, rootCAs);
  const expired = certificateChain.some(({ validity }) =>
    validity.notAfter.getTime() < Date.now() || validity.notBefore.getTime() > Date.now()
  );

  return {
    verified: integrity && authenticity && !expired,
    authenticity,
    integrity,
    expired,
    meta: {
      certs: extractCertificateDetails(forge, certificateChain),
      signatureMeta
    }
  };
}

function sortCertificateChain(certs) {
  const certsArray = Array.from(certs);
  const rootIndex = certsArray.findIndex((cert) => !certsArray.some((other) => cert !== other && other.issued(cert)));
  const chain = rootIndex >= 0 ? [certsArray.splice(rootIndex, 1)[0]] : [];
  while (certsArray.length) {
    const last = chain[0];
    const childIndex = certsArray.findIndex((candidate) => candidate.issued(last));
    if (childIndex < 0) {
      chain.unshift(certsArray.shift());
    } else {
      chain.unshift(certsArray.splice(childIndex, 1)[0]);
    }
  }
  return chain.filter(Boolean);
}

function verifyCertificateChain(forge, certs, rootCAs) {
  if (!certs.length) {
    return false;
  }
  const bundleValid = certs.every((cert, index) => {
    if (index === certs.length - 1) {
      return true;
    }
    return certs[index + 1].issued(cert);
  });
  if (!bundleValid) {
    return false;
  }
  const chainRoot = certs[certs.length - 1];
  return rootCAs.some((pem) => {
    try {
      const rootCert = forge.pki.certificateFromPem(pem);
      return forge.pki.certificateToPem(chainRoot) === pem || rootCert.issued(chainRoot);
    } catch (_) {
      return false;
    }
  });
}

function extractCertificateDetails(forge, certs) {
  return certs.map((cert, index) => ({
    clientCertificate: index === 0,
    issuedBy: mapEntityAttributes(cert.issuer.attributes),
    issuedTo: mapEntityAttributes(cert.subject.attributes),
    validityPeriod: cert.validity,
    pemCertificate: forge.pki.certificateToPem(cert)
  }));
}

function mapEntityAttributes(attributes) {
  return (attributes ?? []).reduce((accumulator, attribute) => {
    if (attribute?.name) {
      accumulator[attribute.name] = attribute.value;
    }
    return accumulator;
  }, {});
}
