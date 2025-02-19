/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import ClassResolver from "./classResolver";
import { BinaryWriter } from "./writer";
import { BinaryReader } from "./reader";
import { ReferenceResolver } from "./referenceResolver";
import { ConfigFlags, Serializer, Config, Language, BinaryReader as BinaryReaderType, BinaryWriter as BinaryWriterType } from "./type";
import { OwnershipError } from "./error";
import { ToRecordType, TypeDescription } from "./description";
import { generateSerializer, AnySerializer } from "./gen";

export default class {
  binaryReader: BinaryReaderType;
  binaryWriter: BinaryWriterType;
  classResolver = new ClassResolver();
  referenceResolver: ReturnType<typeof ReferenceResolver>;
  anySerializer: AnySerializer;

  constructor(public config: Config = {
    refTracking: false,
    useSliceString: false,
    hooks: {
    },
  }) {
    this.binaryReader = BinaryReader(config);
    this.binaryWriter = BinaryWriter(config);
    this.referenceResolver = ReferenceResolver(config, this.binaryWriter, this.binaryReader);
    this.classResolver.init(this);
    this.anySerializer = new AnySerializer(this);
  }

  registerSerializer<T extends TypeDescription>(description: T) {
    const serializer = generateSerializer(this, description);
    return {
      serializer,
      serialize: (data: ToRecordType<T>) => {
        return this.serialize(data, serializer);
      },
      serializeVolatile: (data: ToRecordType<T>) => {
        return this.serializeVolatile(data, serializer);
      },
      deserialize: (bytes: Uint8Array) => {
        return this.deserialize(bytes, serializer) as ToRecordType<T>;
      },
    };
  }

  deserialize<T = any>(bytes: Uint8Array, serializer: Serializer = this.anySerializer): T | null {
    this.referenceResolver.reset();
    this.classResolver.reset();
    this.binaryReader.reset(bytes);
    const bitmap = this.binaryReader.uint8();
    if ((bitmap & ConfigFlags.isNullFlag) === ConfigFlags.isNullFlag) {
      return null;
    }
    const isLittleEndian = (bitmap & ConfigFlags.isLittleEndianFlag) === ConfigFlags.isLittleEndianFlag;
    if (!isLittleEndian) {
      throw new Error("big endian is not supported now");
    }
    const isCrossLanguage = (bitmap & ConfigFlags.isCrossLanguageFlag) == ConfigFlags.isCrossLanguageFlag;
    if (!isCrossLanguage) {
      throw new Error("support crosslanguage mode only");
    }
    this.binaryReader.uint8(); // skip language
    const isOutOfBandEnabled = (bitmap & ConfigFlags.isOutOfBandFlag) === ConfigFlags.isOutOfBandFlag;
    if (isOutOfBandEnabled) {
      throw new Error("outofband mode is not supported now");
    }
    this.binaryReader.int32(); // native object offset. should skip.  javascript support cross mode only
    this.binaryReader.int32(); // native object size. should skip.
    return serializer.read();
  }

  private serializeInternal<T = any>(data: T, serializer: Serializer) {
    try {
      this.binaryWriter.reset();
    } catch (e) {
      if (e instanceof OwnershipError) {
        throw new Error("Permission denied. To release the serialization ownership, you must call the dispose function returned by serializeVolatile.");
      }
      throw e;
    }
    this.referenceResolver.reset();
    this.classResolver.reset();
    let bitmap = 0;
    if (data === null) {
      bitmap |= ConfigFlags.isNullFlag;
    }
    bitmap |= ConfigFlags.isLittleEndianFlag;
    bitmap |= ConfigFlags.isCrossLanguageFlag;
    this.binaryWriter.uint8(bitmap);
    this.binaryWriter.uint8(Language.XLANG);
    const cursor = this.binaryWriter.getCursor();
    this.binaryWriter.skip(4); // preserve 4-byte for nativeObjects start offsets.
    this.binaryWriter.uint32(0); // nativeObjects length.
    // reserve fixed size
    this.binaryWriter.reserve(serializer.meta.fixedSize);
    // start write
    serializer.write(data);
    this.binaryWriter.setUint32Position(cursor, this.binaryWriter.getCursor()); // nativeObjects start offsets;
    return this.binaryWriter;
  }

  serialize<T = any>(data: T, serializer: Serializer = this.anySerializer) {
    return this.serializeInternal(data, serializer).dump();
  }

  serializeVolatile<T = any>(data: T, serializer: Serializer = this.anySerializer) {
    return this.serializeInternal(data, serializer).dumpAndOwn();
  }
}
