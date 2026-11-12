// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Experimental bounded frame codec, not encryption or a call protocol. */
public final class FrameIO {
    public static final int MAX_FRAME_BYTES = 4096;
    private FrameIO() {}
    public static byte[] read(InputStream stream) throws IOException {
        DataInputStream in = new DataInputStream(stream);
        int length = in.readInt();
        if (length < 1 || length > MAX_FRAME_BYTES) throw new IOException("Invalid frame size");
        byte[] body = new byte[length];
        in.readFully(body);
        return body;
    }
    public static void write(OutputStream stream, byte[] body) throws IOException {
        if (body == null || body.length < 1 || body.length > MAX_FRAME_BYTES) throw new IOException("Invalid frame size");
        DataOutputStream out = new DataOutputStream(stream);
        out.writeInt(body.length);
        out.write(body);
        out.flush();
    }
}
