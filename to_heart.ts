"use strict";

import _ from "lodash";
import os from "os";
import fs from "fs";
import path from "path";
import moment from "moment";
import Jimp from "jimp";

import Logger from "../utils/logger";
import Common from "../utils/common";
import AppConfig from "../models/app_config";
import { AppConfigJSON } from "../models/app_config";
import { number, boolean, array } from "yargs";

interface FileInPak {
  name: string;
  pos: number;
  length: number;
  nextPos: number;
  encodedBuf: Buffer;
}

interface ResultOfParsePak {
  filesInPak: FileInPak[];
  keys: number[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Color {
  r: number;
  g: number;
  b: number;
}

interface LF2Image {
  rect: Rect;
  transparent: number;
  colorCount: number;
  palette: Color[];
  pixels: number[];
}

// PAK->LF2
class ToHeart {
  // class variables

  // instance variables
  private _appRootPath = "";
  private _appConfig: AppConfigJSON;

  constructor() {
    Logger.initLogger("egg_to_heart", { level: "ALL", consoleEnabled: true });

    this._appRootPath = path.resolve(os.homedir(), ".egg_to_heart");
    if (!Common.exist(path.resolve(this._appRootPath, "json"))) {
      fs.mkdirSync(path.resolve(this._appRootPath, "json"), { recursive: true });
    }

    // {USER_HOME}/.{appName}/json/app_config.json
    AppConfig.jsonPath = path.resolve(this._appRootPath, "json", "app_config.json");
    this._appConfig = AppConfig.load();
  }

  public async start(inputFilePath: string, inputDirPath: string, outputDirPath: string) {
    Logger.trace("start.");
    // Logger.trace("this._appConfig", this._appConfig);

    if (inputFilePath) {
      // PAKファイルを解凍する
      const resultOfParsePak = this._parsePAK(inputFilePath);
      if (resultOfParsePak) {
        const filesInPak = resultOfParsePak.filesInPak;
        const keys = resultOfParsePak.keys;

        this._printFileTable(filesInPak);

        this._extractPAK(filesInPak, keys, outputDirPath);
      }
    }

    if (inputDirPath) {
      // LF2ファイルをPNGに変換する
      // https://github.com/oliver-moran/jimp
      // https://www.366service.com/jp/qa/187c5ceb9da78c411285c4686d31e309
      const lf2FilePaths = Common.enumFilePaths(inputDirPath, ["lf2"]);
      // const lf2FilePaths = ["../LVNS3DAT/C0102.LF2"];
      // const lf2FilePaths = [
      //   "../LVNS3DAT/C0102.LF2",
      //   "../LVNS3DAT/S30D.LF2",
      //   "../LVNS3DAT/V53.LF2",
      //   "../LVNS3DAT/C030F.LF2",
      // ];
      for (const lf2FilePath of lf2FilePaths) {
        const lf2Image = this._parseLF2(lf2FilePath);
        // const lf2Image = this._parseLF2InPak(filesInPak, "C0101.LF2");
        if (lf2Image) {
          const jimpImage = await this._generateJimpImage(lf2Image);
          if (jimpImage) {
            const lf2FileName = path.basename(lf2FilePath, path.extname(lf2FilePath));
            // 1度でもBMPで保存すると、hasAlphaがtrueになりそれ以降のJPGやBMPが赤っぽくなる

            const outputPNGFilePath = path.join(outputDirPath, `${lf2FileName}.png`);
            await this._saveJimpImageAsPNG(jimpImage, outputPNGFilePath);
          }
        }
      }
    }

    // AppConfig.save(this._appConfig);
    Logger.trace("end.");
  }

  private _parsePAK(pakFilePath: string) {
    const buf = fs.readFileSync(pakFilePath);

    const magicBytesText = this._getMagicBytesText(buf);
    if (magicBytesText === "LEAFPACK") {
      const fileCount = this._getFileCount(buf);
      if (this._isToHeart(fileCount)) {
        const headerPos = this._calcHeaderPos(buf, fileCount);
        const keys = this._findKeys(buf, headerPos);
        const filesInPak = this._parseHeader(buf, fileCount, headerPos, keys);
        return { filesInPak, keys };
      }
    }

    return null;
  }

  private _getMagicBytesText(buf: Buffer) {
    // TODO: 初めて00が現れるまで、という条件にする
    // 0Byte目から7Byte目まで
    // 4C 45 41 46 50 41 43 4B
    const magicBytes = buf.slice(0, 8);
    Logger.trace("magicBytes", magicBytes);

    // ASCIIコードに変換する
    // PAKの場合、「LEAFPACK」
    // LF2の場合、「LEAF256 」
    let magicBytesText = magicBytes.toString("ascii");
    magicBytesText = magicBytesText.replace(/\0/g, "");
    Logger.trace("magicBytesText", magicBytesText);
    return magicBytesText;
  }

  private _getFileCount(buf: Buffer) {
    // 9Byte目から10Byte目まで
    // LVNS3DAT.PAKの場合、48 02
    // LVNS3SCN.PAKの場合、E1 03
    const bytes = buf.slice(8, 10);
    Logger.trace("bytes", bytes);

    const fileCount = bytes.readUIntLE(0, 2);
    Logger.trace("fileCount", fileCount);
    return fileCount;
  }

  private _isToHeart(fileCount: number) {
    // LVNS3DAT.PAKの場合、ファイル数は0x0248 (584)個
    // LVNS3SCN.PAKの場合、ファイル数は0x03E1 (993)個
    if (fileCount === 0x0248 || fileCount === 0x03e1) {
      return true;
    }

    return false;
  }

  private _calcHeaderPos(buf: Buffer, fileCount: number) {
    // ヘッダの先頭を探す
    // ファイル末尾からfileCountぶんさかのぼった位置になる
    // 1ファイルあたり24Byte
    const headerByteCount = fileCount * 24;
    Logger.trace("headerByteCount", headerByteCount);

    const headerPos = buf.length - headerByteCount;
    Logger.trace("buf.length", buf.length);
    Logger.trace("buf.length.toString(16)", buf.length.toString(16));
    Logger.trace("headerPos", headerPos);
    Logger.trace("headerPos.toString(16)", headerPos.toString(16));

    // LVNS3DAT.PAKの場合、
    // LVNS3SCN.PAKの場合、0011918A
    return headerPos;
  }

  private _findKeys(buf: Buffer, headerPos: number) {
    const keys = new Array(11).fill(0);
    Logger.trace("keys.length", keys.length);
    Logger.trace("keys", keys);

    // 3ファイルぶん読んでみる
    const sampledBytes = buf.slice(headerPos, headerPos + 24 * 3);
    Logger.trace("sampledBytes.length", sampledBytes.length);
    Logger.trace("sampledBytes", sampledBytes);
    Logger.trace("Common.convertToHexTextArray(sampledBytes)", Common.convertToHexTextArray(sampledBytes));

    // LVNS3DAT.PAKの場合、
    // 14 88 9B 86 CB 33 C5 17 C8 84 A6 D1 62 6A 56 9A CB FB F7 7C 00 CA D1 58
    // AD 86 CB 43 D7 17 9C 5E C0 17 8A 6A 18 F0 13 A5 8A D0 3E 74 26 03 6A 56
    // DD 43 D6 27 AF 5E 94 F1 A4 B0 88 9A 68 50 F7 7C 9E C8 D1 58 1F 55 9A 13

    // LVNS3SCN.PAKの場合、
    // 01 88 9A 86 BA 33 C5 17 CF 81 C2 D1 62 6A 56 9A 53 A5 F7 7C 88 74 D1 58
    // 9A 86 CA 44 C5 17 9C 5E C7 14 A6 6A A0 9A 13 A5 37 8E 3E 74 5B 6A 6A 56
    // CA 43 D5 29 9C 5E 94 F1 AB AD A4 9A 9D B7 F7 7C 9E 76 D1 58 54 6A 9A 13

    keys[0] = sampledBytes[11]; // D1
    keys[1] = (sampledBytes[12] - 0x0a) & 0xff; // 62 - 0A = 58
    keys[2] = sampledBytes[13]; // 6A
    keys[3] = sampledBytes[14]; // 56
    keys[4] = sampledBytes[15]; // 9A

    keys[5] = (sampledBytes[38] - sampledBytes[22] + keys[0]) & 0xff; // 13 - D1 + D1 = 13
    keys[6] = (sampledBytes[39] - sampledBytes[23] + keys[1]) & 0xff; // A5 - 58 + 58 = A5

    keys[7] = (sampledBytes[62] - sampledBytes[46] + keys[2]) & 0xff; // F7 - 6A + 6A = F7
    keys[8] = (sampledBytes[63] - sampledBytes[47] + keys[3]) & 0xff; // 7C - 56 + 56 = 7C

    keys[9] = (sampledBytes[20] - sampledBytes[36] + keys[3]) & 0xff; // 88 - A0 + 56 = 3E
    keys[10] = (sampledBytes[21] - sampledBytes[37] + keys[4]) & 0xff; // 74 - 9A + 9A = 74

    // LVNS3DAT.PAKの場合、
    // LVNS3SCN.PAKの場合、D1 58 6A 56 9A 13 A5 F7 7C 3E 74
    Logger.trace("keys", keys);
    Logger.trace("Common.convertToHexTextArray(keys)", Common.convertToHexTextArray(keys));
    return keys;
  }

  private _parseHeader(buf: Buffer, fileCount: number, headerPos: number, keys: number[]) {
    const filesInPak = [];

    let k = 0;
    for (let i = 0; i < fileCount; i++) {
      // ファイル名の情報は12Byte
      let fileName = "";
      for (let j = 0; j < 12; j++) {
        const asciiCode = buf[headerPos + i * 24 + j];
        // Logger.trace("asciiCode", asciiCode);

        const decodedAsciiCode = (asciiCode - keys[k]) & 0xff;
        k = ++k % keys.length;

        const chara = String.fromCharCode(decodedAsciiCode);
        // Logger.trace("chara", chara);
        fileName += chara;
        // lp->name[i][j] = (fgetc(lp->fp) - lp->key[k]) & 0xff;
        // k = (++k) % KEY_LEN;
      }

      const fileNameWithDot = this._addDotOfExtension(fileName);
      Logger.trace("fileNameWithDot", fileNameWithDot);

      // ファイル位置の情報は4Byte
      const posBytes: number[] = [];
      for (let j = 0; j < 4; j++) {
        const posByte = buf[headerPos + i * 24 + 12 + j];
        // Logger.trace("posByte", posByte);

        const decodedPosByte = (posByte - keys[k]) & 0xff;
        k = ++k % keys.length;

        posBytes.push(decodedPosByte);
        // b[j] = (fgetc(lp->fp) - lp->key[k]) & 0xff;
        // k = (++k) % KEY_LEN;
      }

      const filePos = (posBytes[3] << 24) + (posBytes[2] << 16) + (posBytes[1] << 8) + posBytes[0];
      Logger.trace("filePos", filePos);
      // lp->pos[i] = (b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0];

      // ファイルの長さの情報は4Byte
      const lengthBytes: number[] = [];
      for (let j = 0; j < 4; j++) {
        const lengthByte = buf[headerPos + i * 24 + 12 + 4 + j];
        // Logger.trace("lengthByte", lengthByte);

        const decodedLengthByte = (lengthByte - keys[k]) & 0xff;
        k = ++k % keys.length;

        lengthBytes.push(decodedLengthByte);
        // b[j] = (fgetc(lp->fp) - lp->key[k]) & 0xff;
        // k = (++k) % KEY_LEN;
      }

      const fileLength = (lengthBytes[3] << 24) + (lengthBytes[2] << 16) + (lengthBytes[1] << 8) + lengthBytes[0];
      Logger.trace("fileLength", fileLength);
      // lp->len[i] = (b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0];

      // 次のファイル位置の情報は4Byte
      const nextPosBytes: number[] = [];
      for (let j = 0; j < 4; j++) {
        const nextPosByte = buf[headerPos + i * 24 + 12 + 4 + 4 + j];
        // Logger.trace("nextPosByte", nextPosByte);

        const decodedNextPosByte = (nextPosByte - keys[k]) & 0xff;
        k = ++k % keys.length;

        nextPosBytes.push(decodedNextPosByte);
        // b[j] = (fgetc(lp->fp) - lp->key[k]) & 0xff;
        // k = (++k) % KEY_LEN;
      }

      const nextFilePos = (nextPosBytes[3] << 24) + (nextPosBytes[2] << 16) + (nextPosBytes[1] << 8) + nextPosBytes[0];
      Logger.trace("nextFilePos", nextFilePos);
      // lp->nextpos[i] = (b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0];

      const encodedBuf = buf.slice(filePos, filePos + fileLength);

      const fileInPak = {
        name: fileNameWithDot,
        pos: filePos,
        length: fileLength,
        nextPos: nextFilePos,
        encodedBuf,
      };

      filesInPak.push(fileInPak);

      // TODO: 総数が一致するか？
    }

    // Logger.trace("filesInPak", filesInPak);
    return filesInPak;
  }

  private _addDotOfExtension(fileName: string) {
    // 「C0101   LF2 」->「C0101.LF2」
    fileName = fileName.slice(0, 8) + "." + fileName.slice(8);
    // 末尾の\を削除する
    // \0にtrimは効かない
    fileName = fileName.replace(/\0/g, "");
    // 途中の空白を削除する
    fileName = fileName.replace(/ /g, "");
    return fileName;
  }

  private _printFileTable(filesInPak: FileInPak[]) {
    console.log(`${filesInPak.length} files.`);
    console.log("FileName\tPosition\tLength\tNextPosition");
    console.log("-".repeat(42));

    for (const fileInPak of filesInPak) {
      console.log(`${fileInPak.name}\t${fileInPak.pos}\t${fileInPak.length}\t${fileInPak.nextPos}`);
    }
  }

  private _extractPAK(filesInPak: FileInPak[], keys: number[], outputDirPath: string) {
    Logger.trace("_extractPAK start.");
    for (let fileInPak of filesInPak) {
      Logger.trace("fileInPak.name", fileInPak.name);
      let k = 0;
      const fileBytes = [];
      for (let i = 0; i < fileInPak.length; i++) {
        const fileByte = fileInPak.encodedBuf[i];
        // Logger.trace("fileByte", fileByte);

        const decodedFileByte = (fileByte - keys[k]) & 0xff;
        k = ++k % keys.length;

        fileBytes.push(decodedFileByte);
      }

      const outputFilePath = path.join(outputDirPath, fileInPak.name);
      let buf = Buffer.from(fileBytes);
      Common.writeBufferToFile(outputFilePath, buf);
    }
  }

  private _parseLF2InPak(filesInPak: FileInPak[], fileName: string) {}

  private _parseLF2(lf2FilePath: string) {
    const buf = fs.readFileSync(lf2FilePath);

    const magicBytesText = this._getMagicBytesText(buf);
    if (magicBytesText === "LEAF256") {
      const rect = this._getRect(buf);
      const transparent = this._getTransparent(buf);
      const colorCount = this._getColorCount(buf);
      const palette = this._getPalette(buf, colorCount);
      const pixels = this._getPixels(buf, rect, colorCount);

      // 画像の上下が逆転して記録されているので、元に戻す
      const reversedPixels = new Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) {
        const pixel = pixels[i];
        const x = i % rect.width;
        const y = Math.floor(i / rect.width);
        reversedPixels[(rect.height - y) * rect.width + x] = pixel;
      }

      return { rect, transparent, colorCount, palette, pixels: reversedPixels };
    }

    return null;
  }

  private _getRect(buf: Buffer) {
    // 幅、高さの情報は8Byte目から
    const xBytes = buf.slice(8, 8 + 2);
    Logger.trace("Common.convertToHexTextArray(xBytes)", Common.convertToHexTextArray(xBytes));
    const x = xBytes.readUIntLE(0, 2);

    const yBytes = buf.slice(10, 10 + 2);
    Logger.trace("Common.convertToHexTextArray(yBytes)", Common.convertToHexTextArray(yBytes));
    const y = yBytes.readUIntLE(0, 2);

    const widthBytes = buf.slice(12, 12 + 2);
    Logger.trace("Common.convertToHexTextArray(widthBytes)", Common.convertToHexTextArray(widthBytes));
    const width = widthBytes.readUIntLE(0, 2);

    const heightBytes = buf.slice(14, 14 + 2);
    Logger.trace("Common.convertToHexTextArray(heightBytes)", Common.convertToHexTextArray(heightBytes));
    const height = heightBytes.readUIntLE(0, 2);

    const rect = { x, y, width, height };
    Logger.trace("rect", rect);
    return rect;
  }

  private _getTransparent(buf: Buffer) {
    // 透過の情報は18Byte目
    const transparent = buf[18];
    Logger.trace("transparent", transparent);
    return transparent;
  }

  private _getColorCount(buf: Buffer) {
    // 色数の情報は22Byte目
    const colorCount = buf[22];
    Logger.trace("colorCount", colorCount);
    return colorCount;
  }

  private _getPalette(buf: Buffer, colorCount: number) {
    // パレットの情報は24Byte目から
    const palette = [];
    for (let i = 0; i < colorCount; i++) {
      const b = buf[24 + 3 * i];
      const g = buf[24 + 1 + 3 * i];
      const r = buf[24 + 2 + 3 * i];
      const color = { r, g, b };
      palette.push(color);
    }

    Logger.trace("palette", palette);
    return palette;
  }

  private _getPixels(buf: Buffer, rect: Rect, colorCount: number) {
    // ピクセルの情報は24+3*colorCount Byte目から
    Logger.trace("buf.length", buf.length);
    Logger.trace("buf.length.toString(16)", buf.length.toString(16));
    Logger.trace("24 + 3 * colorCount", 24 + 3 * colorCount);
    Logger.trace("(24 + 3 * colorCount).toString(16)", (24 + 3 * colorCount).toString(16)); // A8
    Logger.trace("24 + 3 * colorCount + rect.width * rect.height", 24 + 3 * colorCount + rect.width * rect.height);
    // let pixels = new Array(rect.width * rect.height).fill(0);
    let pixels = [];

    // 01 FF F7 FB F9 FF FA FB BB 00 06 FA F9 F9 F9 F8 F0 FF D1 FE F3 42 F6 AD FD F7 F3 E8 E9 1D FD FF 58
    // フラグは01
    // 01は0000001
    // 反転させると11111110
    // FF F7 FB F9 FF FA FBはピクセル情報
    // 反転させると00 08 04 06 00 05 04
    // index105042から入る
    // BB 00は位置情報
    // upperはBB
    // 反転させると44
    // lowerは00
    // 反転させるとFF
    // 長さは44と0FのAND+3で04+3で7
    // 位置は44を右に4bitシフト、FFを左に4ビットシフト
    // 04+FF0でFF4
    // リングバッファの位置FF4からの長さ7Byteぶんがピクセル情報
    // ring_push_iにピクセル情報を控える
    //

    let buf_i = 24 + 3 * colorCount;
    let flag = 0;
    let flagMask = 0;

    const ring = new Array(0x1000).fill(0);
    let ring_push_i = 0x0fee;

    // x, y でループできるのでは？
    let nextStartX = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = nextStartX; x < rect.width; ) {
        // for (let i = 0; i < rect.width * rect.height; ) {
        // 1Byteのフラグが8Byteごとにある
        // 01011111の場合、まず反転させて10100000にする
        // 続く1Byte目、3Byte目にピクセル情報がある
        flagMask >>= 1;
        if (flagMask === 0) {
          flagMask = 0x80;

          flag = buf[buf_i] ^ 0xff;
          buf_i++;
        }

        if (flag & flagMask) {
          // ピクセル情報のByteである
          const pixel = buf[buf_i] ^ 0xff;
          buf_i++;

          pixels.push(pixel);

          ring[ring_push_i] = pixel;
          ring_push_i = (ring_push_i + 1) & 0x0fff;

          x++;
        } else {
          // リングバッファ内の位置情報のByteである
          const compressed = buf.readUIntLE(buf_i, 2) ^ 0xffff;
          buf_i += 2;

          const position = compressed >> 4;
          const length = (compressed & 0x0f) + 3;

          let ring_pop_i = position;
          for (let i = 0; i < length; i++) {
            const pixel = ring[ring_pop_i];
            ring_pop_i = (ring_pop_i + 1) & 0x0fff;

            pixels.push(pixel);

            ring[ring_push_i] = pixel;
            ring_push_i = (ring_push_i + 1) & 0x0fff;
          }

          x += length;
        }

        if (x >= rect.width) {
          nextStartX = x - rect.width;
        }
      }
    }

    // Logger.trace("pixels", pixels);
    return pixels;
  }

  private async _generateJimpImage(lf2Image: LF2Image) {
    const jimpImage = await Jimp.create(lf2Image.rect.width, lf2Image.rect.height, Jimp.rgbaToInt(0, 0, 0, 0));
    if (jimpImage) {
      for (let i = 0; i < lf2Image.pixels.length; i++) {
        const x = i % lf2Image.rect.width;
        const y = Math.floor(i / lf2Image.rect.width);
        let hex = Jimp.rgbaToInt(0, 0, 0, 0);

        const pixel = lf2Image.pixels[i];
        if (pixel === lf2Image.transparent) {
        } else {
          const color = lf2Image.palette[pixel];
          if (color) {
            hex = Jimp.rgbaToInt(color.r, color.g, color.b, 0xff);
          }
        }

        jimpImage.setPixelColor(hex, x, y);
      }

      return jimpImage;
    }

    return null;
  }

  private async _saveJimpImageAsPNG(jimpImage: Jimp, outputFilePath: string) {
    console.log(jimpImage.hasAlpha());
    await jimpImage.writeAsync(outputFilePath);
    // デフォルトの品質は100
  }
}

export default ToHeart;
