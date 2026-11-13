// Rises — BLE (v3.35.0).
// Klasyczny Bluetooth wymaga parowania. To jest droga, ktora dziala bez parowania:
// telefon OGŁASZA sie w eterze, SKANUJE innych i PRZESYLA wiadomosci przez GATT.
// Bez internetu, bez serwera, bez zgody na parowanie — kazde urzadzenie z Rises
// w poblizu staje sie stacja.
package com.risemessenger.app.meshui;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;

public class RisesBleBridge {

    // Wlasny identyfikator uslugi Rises (128 bitow).
    public static final UUID SERVICE = UUID.fromString("7a1e5c30-9b24-4a53-9d21-3f0c5e77a001");
    public static final UUID CHAR = UUID.fromString("7a1e5c30-9b24-4a53-9d21-3f0c5e77a002");

    private static final int ASK = 0x1005;
    private static final int CHUNK = 180;          // bezpieczny kawalek bez negocjacji MTU

    private final Activity activity;
    private final Object lock = new Object();
    private final List<String> inbox = new ArrayList<String>();      // gotowe wiadomosci dla JS
    private final Map<String, long[]> near = new HashMap<String, long[]>(); // hash -> {ostatnio, rssi}
    private final Map<String, byte[]> parts = new HashMap<String, byte[]>();
    private final Map<String, StringBuilder> assembling = new HashMap<String, StringBuilder>();

    private BluetoothGattServer server;
    private BluetoothGatt clientGatt;
    private boolean scanning = false;
    private boolean advertising = false;
    private String status = "nieaktywne";
    private String myNode = "";
    private int heard = 0;

    public RisesBleBridge(Activity activity) {
        this.activity = activity;
    }

    public static void install(Activity activity) {
        try {
            WebView web = null;
            try {
                Object b = activity.getClass().getMethod("getBridge").invoke(activity);
                web = (WebView) b.getClass().getMethod("getWebView").invoke(b);
            } catch (Throwable t) {
                web = null;
            }
            if (web == null) return;
            web.addJavascriptInterface(new RisesBleBridge(activity), "RisesBle");
        } catch (Throwable t) {
            Log.w("RisesBle", "install " + t);
        }
    }

    public String version() { return "1"; }

    public String status() { return status; }

    private BluetoothManager manager() {
        try { return (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE); }
        catch (Throwable t) { return null; }
    }

    private BluetoothAdapter adapter() {
        try {
            BluetoothManager m = manager();
            return m == null ? null : m.getAdapter();
        } catch (Throwable t) { return null; }
    }

    public boolean isSupported() {
        try {
            BluetoothAdapter a = adapter();
            return a != null && a.isMultipleAdvertisementSupported();
        } catch (Throwable t) { return false; }
    }

    public boolean isEnabled() {
        try {
            BluetoothAdapter a = adapter();
            return a != null && a.isEnabled();
        } catch (Throwable t) { return false; }
    }

    public boolean needsLocation() {
        try { return android.os.Build.VERSION.SDK_INT < 31; } catch (Throwable t) { return false; }
    }

    public boolean hasPermissions() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 31) {
                if (activity.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") != 0) return false;
            }
            return activity.checkSelfPermission("android.permission.BLUETOOTH_SCAN") == 0
                && activity.checkSelfPermission("android.permission.BLUETOOTH_ADVERTISE") == 0
                && activity.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") == 0;
        } catch (Throwable t) { return true; }
    }

    public void askPermissions() {
        try {
            List<String> want = new ArrayList<String>();
            want.add("android.permission.BLUETOOTH_CONNECT");
            want.add("android.permission.BLUETOOTH_SCAN");
            want.add("android.permission.BLUETOOTH_ADVERTISE");
            if (android.os.Build.VERSION.SDK_INT < 31) {
                want.add("android.permission.ACCESS_FINE_LOCATION");
            }
            activity.requestPermissions(want.toArray(new String[0]), ASK);
        } catch (Throwable t) { Log.w("RisesBle", "ask " + t); }
    }

    public void ensureOn() {
        try {
            BluetoothAdapter a = adapter();
            if (a == null || a.isEnabled()) return;
            android.content.Intent i = new android.content.Intent("android.bluetooth.adapter.action.REQUEST_ENABLE");
            activity.startActivityForResult(i, 0x1006);
        } catch (Throwable t) {
            try {
                android.content.Intent i = new android.content.Intent("android.bluetooth.adapter.action.REQUEST_ENABLE");
                i.addFlags(0x10000000);
                activity.startActivity(i);
            } catch (Throwable t2) { Log.w("RisesBle", "ensureOn " + t2); }
        }
    }

    public void start(String nodeId) {
        if (nodeId != null && nodeId.length() > 0) myNode = nodeId;
        if (!isSupported()) { status = "to urzadzenie nie rozglasza (brak BLE advertise)"; return; }
        if (!isEnabled()) { status = "radio wylaczone"; ensureOn(); return; }
        if (!hasPermissions()) { status = "czeka na zgode"; askPermissions(); return; }
        startServer();
        startScan();
        startAdvertise();
    }

    public void stop() {
        try { if (clientGatt != null) { clientGatt.close(); clientGatt = null; } } catch (Throwable t) {}
        try { if (server != null) { server.close(); server = null; } } catch (Throwable t) {}
        try {
            BluetoothAdapter a = adapter();
            BluetoothLeScanner s = a == null ? null : a.getBluetoothLeScanner();
            if (s != null && scanning) s.stopScan(scanCallback);
        } catch (Throwable t) {}
        try {
            BluetoothAdapter a = adapter();
            BluetoothLeAdvertiser adv = a == null ? null : a.getBluetoothLeAdvertiser();
            if (adv != null && advertising) adv.stopAdvertising(advCallback);
        } catch (Throwable t) {}
        scanning = false; advertising = false; status = "zatrzymane";
    }

    public boolean isRunning() { return scanning && advertising; }

    // --- GATT serwer: przyjmuje wiadomosci od innych telefonow ---
    private void startServer() {
        if (server != null) return;
        try {
            BluetoothManager m = manager();
            if (m == null) return;
            server = m.openGattServer(activity, serverCallback);
            if (server == null) { status = "brak serwera GATT"; return; }
            BluetoothGattService svc = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            BluetoothGattCharacteristic ch = new BluetoothGattCharacteristic(
                CHAR,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
            svc.addCharacteristic(ch);
            server.addService(svc);
        } catch (Throwable t) { Log.w("RisesBle", "server " + t); }
    }

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                BluetoothGattCharacteristic c, boolean preparedWrite, boolean responseNeeded,
                int offset, byte[] value) {
            try {
                String key = "";
                try { key = device.getAddress(); } catch (Throwable t) {}
                take(key == null ? "" : key, value);
                if (responseNeeded && server != null) {
                    server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
                }
                synchronized (lock) { near.put(key, new long[] { System.currentTimeMillis(), 0 }); }
            } catch (Throwable t) { Log.w("RisesBle", "onWrite " + t); }
        }
    };

    // Sklada kawalki w wiadomosc: [magic 2][id 2][nr 1][ile 1][dlugosc 2][tresc]
    private void take(String from, byte[] chunk) {
        try {
            if (chunk == null || chunk.length < 8) return;
            if (chunk[0] != 'R' || chunk[1] != 'S') return;
            int id = ((chunk[2] & 0xff) << 8) | (chunk[3] & 0xff);
            int idx = chunk[4] & 0xff;
            int total = chunk[5] & 0xff;
            int len = ((chunk[6] & 0xff) << 8) | (chunk[7] & 0xff);
            String key = from + ":" + id;
            synchronized (lock) {
                StringBuilder sb = assembling.get(key);
                if (sb == null || idx == 0) { sb = new StringBuilder(); assembling.put(key, sb); }
                sb.append(new String(chunk, 8, Math.min(len, chunk.length - 8), StandardCharsets.UTF_8));
                if (idx + 1 >= total) {
                    String full = sb.toString();
                    assembling.remove(key);
                    heard++;
                    inbox.add(Base64.encodeToString(full.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                    while (inbox.size() > 300) inbox.remove(0);
                }
            }
        } catch (Throwable t) { Log.w("RisesBle", "take " + t); }
    }

    // --- rozglaszanie siebie ---
    // 7 bajtow: 'R','S', wersja, hash wezla. Z identyfikatorem firmy (2 B) razem 11 B
    // w strukturze AD — miesci sie w 31-bajtowej ramce rozglaszania z duzym zapasem.
    // Wczesniej pakiet z 128-bitowym UUID mial 25 B i mogl zostac odrzucony
    // przez system komunikatem ADVERTISE_FAILED_DATA_TOO_LARGE.
    private byte[] beacon() {
        int h = myNode.length() == 0 ? 0 : myNode.hashCode();
        return new byte[] { 0x52, 0x53, 0x01,
            (byte) (h >>> 24), (byte) (h >>> 16), (byte) (h >>> 8), (byte) h };
    }

    private static final int COMPANY = 0xFFFF;   // zarezerwowany do testow

    private AdvertiseData advData(boolean full) {
        byte[] b = beacon();
        if (!full) {
            b = new byte[] { 0x52, 0x53, 0x01, b[3], b[4], b[5], b[6] };
        }
        return new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addManufacturerData(COMPANY, b)
            .build();
    }

    private void startAdvertise() {
        if (advertising) return;
        try {
            BluetoothAdapter a = adapter();
            BluetoothLeAdvertiser adv = a == null ? null : a.getBluetoothLeAdvertiser();
            if (adv == null) { status = "brak rozglaszania BLE"; return; }
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)                 // zeby mozna bylo przyslac wiadomosc
                .setTimeout(0)
                .build();
            adv.startAdvertising(settings, advData(true), advCallback);
            advertising = true;
        } catch (Throwable t) { status = "oglaszanie odrzucone: " + t; }
    }

    // --- skanowanie innych telefonow z Rises ---
    private void startScan() {
        if (scanning) return;
        try {
            BluetoothAdapter a = adapter();
            BluetoothLeScanner s = a == null ? null : a.getBluetoothLeScanner();
            if (s == null) { status = "brak skanera BLE"; return; }
            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
            s.startScan((List<android.bluetooth.le.ScanFilter>) new ArrayList<android.bluetooth.le.ScanFilter>(), settings, scanCallback);
            scanning = true;
        } catch (Throwable t) { status = "skanowanie odrzucone: " + t; }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            try {
                ScanRecord rec = r.getScanRecord();
                if (rec == null) return;
                byte[] sd = null;
                try { sd = rec.getManufacturerSpecificData(COMPANY); } catch (Throwable t) { sd = null; }
                if (sd == null) {                      // zgodnosc ze starszym formatem
                    try { sd = rec.getServiceData(new ParcelUuid(SERVICE)); } catch (Throwable t) { sd = null; }
                }
                if (sd == null || sd.length < 7) return;
                if (sd[0] != 'R' || sd[1] != 'S') return;
                int h = ((sd[3] & 0xff) << 24) | ((sd[4] & 0xff) << 16) | ((sd[5] & 0xff) << 8) | (sd[6] & 0xff);
                int mine = myNode.length() == 0 ? 0 : myNode.hashCode();
                if (h == mine) return;                       // to ja
                String mac = "";
                try { mac = r.getDevice().getAddress(); } catch (Throwable t) {}
                String key = mac + "|" + Integer.toHexString(h);
                synchronized (lock) {
                    near.put(key, new long[] { System.currentTimeMillis(), r.getRssi() });
                }
            } catch (Throwable t) { Log.w("RisesBle", "scan " + t); }
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (int i = 0; i < results.size(); i++) onScanResult(0, results.get(i));
        }

        @Override
        public void onScanFailed(int code) { status = "skan nie wyszedl (kod " + code + ")"; }
    };

    private final AdvertiseCallback advCallback = new AdvertiseCallback() {
        @Override public void onStartSuccess(AdvertiseSettings s) { status = "dziala: widze i jestem widziany"; }
        @Override public void onStartFailure(int code) { status = "oglaszanie nie wyszlo (kod " + code + ")"; }
    };

    // --- wysylanie wiadomosci do obcego telefonu (bez parowania) ---
    public void send(final String mac, final String text) {
        try {
            BluetoothAdapter a = adapter();
            if (a == null || mac == null || text == null) return;
            BluetoothDevice dev = a.getRemoteDevice(mac);
            final byte[] data = text.getBytes(StandardCharsets.UTF_8);
            final int total = Math.max(1, (data.length + CHUNK - 1) / CHUNK);
            final int id = (int) (System.nanoTime() & 0xffff);
            final int[] sent = new int[] { 0 };
            clientGatt = dev.connectGatt(activity, false, new BluetoothGattCallback() {
                @Override
                public void onConnectionStateChange(BluetoothGatt g, int st, int ns) {
                    try {
                        if (ns == BluetoothProfile.STATE_CONNECTED) {
                            g.discoverServices();
                        } else {
                            g.close();
                        }
                    } catch (Throwable t) { Log.w("RisesBle", "conn " + t); }
                }

                @Override
                public void onServicesDiscovered(BluetoothGatt g, int st) {
                    try {
                        BluetoothGattService svc = g.getService(SERVICE);
                        if (svc == null) { g.disconnect(); return; }
                        BluetoothGattCharacteristic c = svc.getCharacteristic(CHAR);
                        if (c == null) { g.disconnect(); return; }
                        for (int idx = 0; idx < total; idx++) {
                            int off = idx * CHUNK;
                            int len = Math.min(CHUNK, data.length - off);
                            byte[] ch = new byte[8 + len];
                            ch[0] = 'R'; ch[1] = 'S';
                            ch[2] = (byte) ((id >> 8) & 0xff);
                            ch[3] = (byte) (id & 0xff);
                            ch[4] = (byte) idx;
                            ch[5] = (byte) total;
                            ch[6] = (byte) ((len >> 8) & 0xff);
                            ch[7] = (byte) (len & 0xff);
                            System.arraycopy(data, off, ch, 8, len);
                            c.setValue(ch);
                            c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                            g.writeCharacteristic(c);
                            try { Thread.sleep(40); } catch (Throwable t) {}
                        }
                        try { Thread.sleep(120); } catch (Throwable t) {}
                        g.disconnect();
                    } catch (Throwable t) { Log.w("RisesBle", "send " + t); }
                }
            });
        } catch (Throwable t) { Log.w("RisesBle", "send outer " + t); }
    }

    // Ile osob z Rises jest w poblizu (ostatnie 2 minuty).
    public int nearCount() {
        long now = System.currentTimeMillis();
        int n = 0;
        synchronized (lock) {
            Iterator<Map.Entry<String, long[]>> it = near.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, long[]> e = it.next();
                if (now - e.getValue()[0] > 120000) { it.remove(); continue; }
                n++;
            }
        }
        return n;
    }

    // Lista pobliskich: "mac|rssi" w kolejnych liniach.
    public String peers() {
        long now = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder();
        synchronized (lock) {
            Iterator<Map.Entry<String, long[]>> it = near.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, long[]> e = it.next();
                if (now - e.getValue()[0] > 120000) { it.remove(); continue; }
                String key = e.getKey();
                String mac = key.indexOf('|') >= 0 ? key.substring(0, key.indexOf('|')) : key;
                if (sb.length() > 0) sb.append('\n');
                sb.append(mac).append('|').append(e.getValue()[1]);
            }
        }
        return sb.toString();
    }

    // Zabiera odebrane wiadomosci (kazda w base64).
    public String poll() {
        synchronized (lock) {
            if (inbox.isEmpty()) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < inbox.size(); i++) {
                if (i > 0) sb.append('\n');
                sb.append(inbox.get(i));
            }
            inbox.clear();
            return sb.toString();
        }
    }

    public int heardCount() { return heard; }
}
