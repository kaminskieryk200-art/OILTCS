// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Unreleased BLE framing experiment; NOT a GATT transport or encryption.
 * One ordered frame at a time per authenticated link, max 4096 bytes. Fragments
 * must be carried by a reliable ordered link or gaps cancel the frame. The
 * header is unauthenticated and peer-controlled: callers must impose peer and
 * bandwidth limits, authenticate/decrypt the fully reassembled packet, and must
 * never use message sequence numbers as proof of identity or delivery. */
public final class BleFrameCodecLab {
 public static final int MAX_FRAME=4096, HEADER=12, MIN_VALUE=20, MAX_VALUE=512;
 public static final long FRAME_TIMEOUT_MS=10000, MAX_ASSEMBLY_MS=120000;
 private BleFrameCodecLab(){}
 /** valueBytes is the negotiated maximum ATT characteristic-value size, not
  * the ATT MTU. Caller is responsible for using actual negotiated limits. */
 public static List<byte[]> fragment(int sequence,byte[] frame,int valueBytes){
  if(frame==null||frame.length<1||frame.length>MAX_FRAME||valueBytes<MIN_VALUE||valueBytes>MAX_VALUE)throw new IllegalArgumentException();
  int capacity=valueBytes-HEADER;List<byte[]> out=new ArrayList<>();
  for(int off=0;off<frame.length;off+=capacity){
   int n=Math.min(capacity,frame.length-off);
   ByteBuffer b=ByteBuffer.allocate(HEADER+n);b.put((byte)'R').put((byte)'B').put((byte)1).put((byte)0).putInt(sequence).putShort((short)frame.length).putShort((short)off).put(frame,off,n);out.add(b.array());
  }
  return out;
 }
 public static final class Receiver {
  private byte[] pending;private int seq,offset;private long lastNow=-1,started,lastProgress;
  /** Return null until a complete frame arrives. On any malformed, out-of-order,
   * overlapping, timed-out or mismatching fragment, discard partial state and
   * throw; caller must restart transmission with a fresh frame/sequence. */
  public byte[] accept(byte[] part,int valueBytes,long now){
   if(now<0||lastNow>now){reset();throw new IllegalArgumentException("clock");}lastNow=now;
   try{
    if(valueBytes<MIN_VALUE||valueBytes>MAX_VALUE||part==null||part.length<=HEADER||part.length>valueBytes)throw new IllegalArgumentException("size");
    if(pending!=null&&(now-lastProgress>=FRAME_TIMEOUT_MS||now-started>=MAX_ASSEMBLY_MS))throw new IllegalArgumentException("expired");
    ByteBuffer b=ByteBuffer.wrap(part);
    if(b.get()!='R'||b.get()!='B'||b.get()!=1||b.get()!=0)throw new IllegalArgumentException("header");
    int id=b.getInt(),size=b.getShort()&65535,off=b.getShort()&65535,len=b.remaining();
    if(size<1||size>MAX_FRAME||off>=size||len>size-off)throw new IllegalArgumentException("range");
    if(pending==null){if(off!=0)throw new IllegalArgumentException("not first");pending=new byte[size];seq=id;offset=0;started=now;lastProgress=now;}
    if(id!=seq||size!=pending.length||off!=offset)throw new IllegalArgumentException("sequence");
    b.get(pending,offset,len);offset+=len;lastProgress=now;
    if(offset==pending.length){byte[] result=pending.clone();reset();return result;}
    return null;
   }catch(RuntimeException e){reset();throw e;}
  }
  /** Forget current partial packet, such as on disconnection. */
  public void reset(){if(pending!=null)Arrays.fill(pending,(byte)0);pending=null;offset=0;}
 }
}
