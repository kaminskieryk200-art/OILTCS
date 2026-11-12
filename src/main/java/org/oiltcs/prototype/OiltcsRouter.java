// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** OILTCS research protocol v0: bounded, in-memory, live multi-hop flooding.
 * It does NOT encrypt or authenticate the routing header, discover neighbours,
 * persist packets, find routes, guarantee delivery, defend against malicious
 * peers, bill, or cross an absent physical path. Payload protection is supplied
 * separately by a verified endpoint session. Forwarders can see metadata and
 * drop, duplicate, inject or poison frames. Incompatible with legacy MeshRouter.
 * Not audited and not suitable for production or confidential traffic. */
public final class OiltcsRouter {
 public static final int MAX_HOPS=64, MAX_PEERS=16, MAX_SEEN=8192;
 private static final int ID=16, HEADER=40, VERSION=0, BURST=200, PER_SECOND=200;
 private static final byte[] MAGIC={79,73,76,84}; // OILT
 public interface Link {void send(byte[] packet)throws IOException;}
 public interface Sink {void onPacket(byte[] opaquePayload);}
 public interface Clock {long nanoTime();}
 private static final class Peer {
  final Link link;double tokens=BURST;long last;boolean initialized;
  Peer(Link link){this.link=link;}
  boolean allow(long now){
   if(!initialized){initialized=true;last=now;}
   long diff=now-last;if(diff>0){tokens=Math.min(BURST,tokens+(double)diff*PER_SECOND/1_000_000_000d);last=now;}
   if(tokens<1)return false;tokens-=1;return true;
  }
 }
 private final byte[] self;private final Sink sink;private final Clock clock;
 private final Map<String,Peer> peers=new LinkedHashMap<>();
 private final LinkedHashMap<String,Boolean> seen=new LinkedHashMap<>();
 private boolean enabled;
 public OiltcsRouter(byte[] self,Sink sink){this(self,sink,System::nanoTime);}
 /** Clock injection is for deterministic tests; a monotonic clock is required. */
 public OiltcsRouter(byte[] self,Sink sink,Clock clock){if(self==null||self.length!=ID||sink==null||clock==null)throw new IllegalArgumentException();this.self=self.clone();this.sink=sink;this.clock=clock;}
 public synchronized void enable(){enabled=true;}
 public synchronized void disable(){enabled=false;peers.clear();seen.clear();}
 public synchronized void addPeer(String name,Link link){
  if(!enabled)throw new IllegalStateException("relay disabled");
  if(name==null||name.isEmpty()||name.length()>128||link==null)throw new IllegalArgumentException();
  if(!peers.containsKey(name)&&peers.size()>=MAX_PEERS)throw new IllegalStateException("peer limit");
  peers.put(name,new Peer(link));
 }
 public synchronized void removePeer(String name){peers.remove(name);}
 /** Fresh, unpredictable 16-byte msgId required for every packet, including retries. */
 public void send(byte[] dest,byte[] msgId,byte[] payload,int hops){
  if(dest==null||dest.length!=ID||msgId==null||msgId.length!=ID||payload==null||payload.length<1||payload.length>FrameIO.MAX_FRAME_BYTES-HEADER||hops<1||hops>MAX_HOPS)throw new IllegalArgumentException();
  byte[] wire=new byte[HEADER+payload.length];System.arraycopy(MAGIC,0,wire,0,4);wire[4]=VERSION;wire[5]=(byte)hops;
  System.arraycopy(msgId,0,wire,6,ID);System.arraycopy(dest,0,wire,22,ID);wire[38]=(byte)(payload.length>>>8);wire[39]=(byte)payload.length;System.arraycopy(payload,0,wire,HEADER,payload.length);
  route(null,wire);
 }
 public void receive(String from,byte[] wire){if(from==null)throw new IllegalArgumentException();route(from,wire);}
 private void route(String from,byte[] input){
  if(input==null||input.length<=HEADER||input.length>FrameIO.MAX_FRAME_BYTES)return;
  byte[] packet=input.clone();if(packet[0]!=MAGIC[0]||packet[1]!=MAGIC[1]||packet[2]!=MAGIC[2]||packet[3]!=MAGIC[3]||packet[4]!=VERSION)return;
  int hops=packet[5]&255,length=((packet[38]&255)<<8)|(packet[39]&255);if(hops<1||hops>MAX_HOPS||length!=packet.length-HEADER)return;
  List<Link> outputs=new ArrayList<>();boolean local;
  synchronized(this){
   if(!enabled)return;
   if(from!=null){Peer peer=peers.get(from);if(peer==null||!peer.allow(clock.nanoTime()))return;}
   String id=hex(packet,6,ID);if(seen.containsKey(id))return;
   seen.put(id,Boolean.TRUE);if(seen.size()>MAX_SEEN)seen.remove(seen.keySet().iterator().next());
   local=Arrays.equals(self,Arrays.copyOfRange(packet,22,38));
   if(!local&&(from==null||hops>1)){
    if(from!=null)packet[5]=(byte)(hops-1);
    for(Map.Entry<String,Peer> e:peers.entrySet())if(!e.getKey().equals(from))outputs.add(e.getValue().link);
   }
  }
  if(local){sink.onPacket(Arrays.copyOfRange(packet,HEADER,packet.length));return;}
  for(Link l:outputs)try{l.send(packet.clone());}catch(IOException ignored){} // delivery is not guaranteed
 }
 private static String hex(byte[] p,int offset,int length){char[] symbols="0123456789abcdef".toCharArray(),out=new char[length*2];for(int i=0;i<length;i++){int v=p[offset+i]&255;out[i*2]=symbols[v>>>4];out[i*2+1]=symbols[v&15];}return new String(out);}
}
