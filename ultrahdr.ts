import fs from 'fs';
import { execSync } from 'child_process';
import Jimp from 'jimp';
// @ts-ignore
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { DataUtils } from 'three';

(async () => {
  const startTime = Date.now();

  const [ hdrSource, extOutputPath ] = process.argv.slice(2);
  const saturate = (value: number) => Math.min(1, Math.max(0, value));
  const rgbeLoader = new RGBELoader();

  const getGainmap = async ({
    maxContentBoost,
    sdrFile,
    hdrFile,
    outputPath
  }) => {
    const gainmap = await Jimp.read(fs.readFileSync(sdrFile));
    const sdrImage = await Jimp.read(fs.readFileSync(sdrFile));
    const hdrImage = rgbeLoader.parse(fs.readFileSync(hdrFile));

    const sdrRange = 255;

    gainmap.scan(0, 0, gainmap.bitmap.width, gainmap.bitmap.height, (x, y, idx) => {
      const sdrColor = {
        r: sdrImage.bitmap.data[idx + 0] / sdrRange,
        g: sdrImage.bitmap.data[idx + 1] / sdrRange,
        b: sdrImage.bitmap.data[idx + 2] / sdrRange,
      };
      const hdrColor = {
        r: DataUtils.fromHalfFloat(hdrImage.data[idx + 0]),
        g: DataUtils.fromHalfFloat(hdrImage.data[idx + 1]),
        b: DataUtils.fromHalfFloat(hdrImage.data[idx + 2]),
      };

      const offsetSdr = 1 / 64;
      const offsetHdr = 1 / 64;
      const pixelGain = {
        r: (hdrColor.r + offsetHdr) / (sdrColor.r + offsetSdr),
        g: (hdrColor.g + offsetHdr) / (sdrColor.g + offsetSdr),
        b: (hdrColor.b + offsetHdr) / (sdrColor.b + offsetSdr)
      };
      const minLog2 = Math.log2(1.0);
      const maxLog2 = Math.log2(Math.max(maxContentBoost, 1.0001));
      const logRecovery = {
        r: (Math.log2(pixelGain.r) - minLog2) / (maxLog2 - minLog2),
        g: (Math.log2(pixelGain.g) - minLog2) / (maxLog2 - minLog2),
        b: (Math.log2(pixelGain.b) - minLog2) / (maxLog2 - minLog2)
      };
      const clampedRecovery = {
        r: saturate(logRecovery.r),
        g: saturate(logRecovery.g),
        b: saturate(logRecovery.b)
      };

      gainmap.bitmap.data[idx + 0] = clampedRecovery.r * sdrRange;
      gainmap.bitmap.data[idx + 1] = clampedRecovery.g * sdrRange;
      gainmap.bitmap.data[idx + 2] = clampedRecovery.b * sdrRange;
    });
    gainmap.resize(gainmap.bitmap.width / 4, gainmap.bitmap.height / 4, Jimp.RESIZE_NEAREST_NEIGHBOR);
    // gainmap.quality(80);
    await gainmap.writeAsync(outputPath);

    return gainmap;
  };

  if (!hdrSource) {
    throw 'Pass hdr file as arguments';
  }

  if (!fs.existsSync(hdrSource)) {
    throw 'HDR file not found';
  }

  const sourceFileName = hdrSource.split('/').pop()!.replace('.hdr', '');

  try {
    execSync(`mkdir ${__dirname}/output-${sourceFileName}`, { encoding: 'utf8' });
  } catch {}

  const outputPath = `${__dirname}/output-${sourceFileName}`;

  // 1. Convert HDR to sRGB SDR

  const sRGBSDRFile = `${outputPath}/${sourceFileName}-srgb-sdr.jpg`;
  execSync(`magick ${hdrSource} -sampling-factor 4:2:0 -strip -quality 90 -interlace JPEG -clamp -colorspace sRGB ${sRGBSDRFile}`, { encoding: 'utf8' });
  execSync(`exiftool -all= ${sRGBSDRFile}`, { encoding: 'utf8' });

  const RGBSDRFile = `${outputPath}/${sourceFileName}-rgb-sdr.jpg`;
  execSync(`magick ${sRGBSDRFile} -clamp -colorspace RGB ${RGBSDRFile}`, { encoding: 'utf8' });

  // 2. Get max HDR value
  const maxContentBoost = parseFloat(execSync(`magick identify -colorspace sRGB -format "%[max]" ${hdrSource}`, { encoding: 'utf8' })) / Math.pow(2, 15);

  const GAINMAPFile = `${outputPath}/${sourceFileName}-gainmap.jpg`;
  await getGainmap({
    maxContentBoost: maxContentBoost,
    sdrFile: RGBSDRFile,
    hdrFile: hdrSource,
    outputPath: GAINMAPFile
  });
  execSync(`exiftool -all= ${GAINMAPFile}`, { encoding: 'utf8' });
  execSync(`magick ${GAINMAPFile} -sampling-factor 4:2:0 -strip -quality 90 -interlace JPEG -clamp ${GAINMAPFile}`, { encoding: 'utf8' });

  const xmlNamespace = Buffer.from('http://ns.adobe.com/xap/1.0/ ', 'utf8');
  const xmlIsoNameSpace = Buffer.from('urn:iso:std:iso:ts:21496:-1 ', 'utf8');

  const baseSDR = fs.readFileSync(sRGBSDRFile);
  const baseGainmap = fs.readFileSync(GAINMAPFile);

  const metadataPayloadXML2 = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description
      xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"
      hdrgm:Version="1.0"
      hdrgm:GainMapMin="${Math.log2(1.0)}"
      hdrgm:GainMapMax="${Math.log2(Math.max(maxContentBoost, 1.0001))}"
      hdrgm:Gamma="1.0"
      hdrgm:OffsetSDR="${1 / 64}"
      hdrgm:OffsetHDR="${1 / 64}"
      hdrgm:HDRCapacityMin="${Math.log2(1.0)}"
      hdrgm:HDRCapacityMax="${Math.log2(Math.max(maxContentBoost, 1.0001))}"
      hdrgm:BaseRenditionIsHDR="False"
      />
    </rdf:RDF>
  </x:xmpmeta> `, 'utf8');

  const mpfSecondaryImageSize = 2 + (2 + xmlNamespace.byteLength + metadataPayloadXML2.byteLength) + baseGainmap.byteLength;

  const metadataPayloadXML = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description
      xmlns:Container="http://ns.google.com/photos/1.0/container/"
      xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
      xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"
      hdrgm:Version="1.0">
        <Container:Directory>
          <rdf:Seq>
            <rdf:li rdf:parseType="Resource">
              <Container:Item
              Item:Semantic="Primary"
              Item:Mime="image/jpeg"/>
            </rdf:li>
            <rdf:li rdf:parseType="Resource">
              <Container:Item
              Item:Semantic="GainMap"
              Item:Mime="image/jpeg"
              Item:Length="${mpfSecondaryImageSize}"/>
            </rdf:li>
          </rdf:Seq>
        </Container:Directory>
      </rdf:Description>
    </rdf:RDF>
  </x:xmpmeta> `, 'utf8');

  const xmpBuffer: number[] = [];

  const xmpAppend = (...valueOrValues) => {
    if (valueOrValues.length > 1) {
      valueOrValues.forEach(v => xmpAppend(v));
    } else {
      for (let i = 0; i >= 0; i--) {
        xmpBuffer.push((valueOrValues[0] >> (8 * i)) & 0xFF);
      }
    }
  };

  const xmpAppendSwapEdian32 = (...valueOrValues) => {
    if (valueOrValues.length > 1) {
      valueOrValues.forEach(v => xmpAppend(v));
    } else {
      const temp: number[] = [];
      const hex = valueOrValues[0].toString(16).padStart(8, '0');

      for (let i = 0; i < 4; i++) {
        temp.push(parseInt(`${hex.substr(i * 2, 2)}`, 16));
      }

      xmpBuffer.push(...temp.reverse());
    }
  };

  // NOTE FF01
  xmpAppend(0xff, 0xd8, 0xff, 0xe1);
  xmpBuffer.push(
    ((2 + xmlNamespace.byteLength + metadataPayloadXML.byteLength) >> 8) & 0xff,
    (2 + xmlNamespace.byteLength + metadataPayloadXML.byteLength) & 0xff
  );
  xmpBuffer.push(...xmlNamespace);
  xmpBuffer.push(...metadataPayloadXML);

  // TODO Write FFE0 JFIF marker?

  // NOTE FF02 (ISO)
  // xmpAppend(0xff, 0xe2);
  // xmpBuffer.push(
  //   ((2 + xmlIsoNameSpace.byteLength + 4) >> 8) & 0xff,
  //   (2 + xmlIsoNameSpace.byteLength + 4) & 0xff
  // );
  // xmpBuffer.push(...xmlIsoNameSpace);
  // xmpAppend(0x00, 0x00, 0x00, 0x00);

  // NOTE FF02 (MPF) (SDR=sRGBSDRFile)

  const mpfSig = Buffer.from('MPF ', 'utf8');
  const mpfLength = 2 + mpfSig.byteLength + 4 + 4 + 2 + 3 * 12 + 4 + 2 * 16;
  const mpfPrimaryImageSize = xmpBuffer.length + mpfLength + baseSDR.byteLength;
  const mpfSecondaryImageOffset = mpfPrimaryImageSize - xmpBuffer.length - 8;

  xmpAppend(0xff, 0xe2);
  xmpBuffer.push(
    ((mpfLength >> 8) & 0xff),
    (mpfLength & 0xff)
  );
  xmpBuffer.push(...mpfSig);
  xmpAppend(0x49, 0x49, 0x2A, 0x00);
  xmpAppend(
    0x08,
    0x00,
    0x00,
    0x00,
    0x03,
    0x00,
    0x00,
    0xB0,
    0x07,
    0x00,
    0x04,
    0x00,
    0x00,
    0x00,
    0x30,
    0x31,
    0x30,
    0x30,
    0x01,
    0xB0,
    0x04,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    0x00,
    0x00,
    0x02,
    0xB0,
    0x07,
    0x00,
    0x20,
    0x00,
    0x00,
    0x00,
    0x32,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x03,
    0x00,
  );
  xmpAppendSwapEdian32(mpfPrimaryImageSize);
  xmpAppend(0x00, 0x00, 0x00, 0x00);
  xmpAppend(0x00, 0x00);
  xmpAppend(0x00, 0x00);
  xmpAppend(0x00, 0x00, 0x00, 0x00); // kMPEntryAttributeFormatJpeg
  xmpAppendSwapEdian32(mpfSecondaryImageSize);
  xmpAppendSwapEdian32(mpfSecondaryImageOffset);
  xmpAppend(0x00, 0x00);
  xmpAppend(0x00, 0x00);

  // NOTE Finished primary image

  const xmpArrayBuffer = new Uint8Array(xmpBuffer.slice(0)).buffer;
  const primaryImageMetadata = Buffer.from(xmpArrayBuffer);

  xmpBuffer.length = 0;

  // NOTE Secondary image
  xmpAppend(0xff, 0xd8, 0xff, 0xe1);
  xmpBuffer.push(
    ((2 + xmlNamespace.byteLength + metadataPayloadXML2.byteLength) >> 8) & 0xff,
    (2 + xmlNamespace.byteLength + metadataPayloadXML2.byteLength) & 0xff
  );
  xmpBuffer.push(...xmlNamespace);
  xmpBuffer.push(...metadataPayloadXML2);

  // NOTE Finished secondary image

  const xmpArrayBuffer2 = new Uint8Array(xmpBuffer).buffer;
  const secondaryImageMetadata = Buffer.from(xmpArrayBuffer2);

  const output = Buffer.concat([
    primaryImageMetadata,
    baseSDR.subarray(2),
    secondaryImageMetadata,
    baseGainmap.subarray(2),
  ]);

  const finalResult = `${outputPath}/${sourceFileName}.hdr.jpg`;

  fs.writeFileSync(finalResult, output);
  fs.copyFileSync(finalResult, hdrSource.replace('.hdr', '.hdr.jpg'));

  const fileSizeInput = fs.statSync(hdrSource).size;
  const fileSizeOutput = fs.statSync(finalResult).size;

  console.log(`Input: ${fileSizeInput} bytes`);
  console.log(`Output: ${fileSizeOutput} bytes`);
  console.log(`Compression: ${((1 - (fileSizeOutput / fileSizeInput)) * 100).toFixed(2)}%`);

  console.log(`Time: ${(Date.now() - startTime) / 1000}s`);
})();
