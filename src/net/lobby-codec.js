// Stable serialization and lobby control messages.
import { rtcTextDecoder, rtcTextEncoder } from './rtc-transport.js';

class StableSerializationUtil{
  static stableStringify(value){
    if(value===null||typeof value!=="object")return JSON.stringify(value);
    if(Array.isArray(value))return "["+value.map(v=>this.stableStringify(v)).join(",")+"]";
    const keys=Object.keys(value).sort();
    return "{"+keys.map(k=>JSON.stringify(k)+":"+this.stableStringify(value[k])).join(",")+"}";
  }
}

class LobbyControlCodec{
  static encodeRtcMessage(message){
    const json=rtcTextEncoder.encode(JSON.stringify(message)),out=new Uint8Array(5+json.byteLength);
    new DataView(out.buffer).setUint32(1,json.byteLength,false);out.set(json,5);return out.buffer;
  }
  static decodeRtcMessage(buffer){
    const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
    if(bytes.byteLength<5||bytes[0]!==0)throw new Error('lobby-frame-format');
    const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(1,false);
    if(5+length!==bytes.byteLength)throw new Error('lobby-frame-length');
    return JSON.parse(rtcTextDecoder.decode(bytes.subarray(5)));
  }
}
class ConnectionRoleUtil{static sideRole(side){return side===0?"host":"guest"}}
class ConnectionSideUtil{static roleSide(role){return role==="host"?0:1}}

export { ConnectionRoleUtil, ConnectionSideUtil, LobbyControlCodec, StableSerializationUtil };
