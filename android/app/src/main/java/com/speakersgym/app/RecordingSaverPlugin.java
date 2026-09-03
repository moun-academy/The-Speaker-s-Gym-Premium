package com.speakersgym.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(
    name = "RecordingSaver",
    permissions = @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "legacyStorage")
)
public class RecordingSaverPlugin extends Plugin {

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not open Speaker's Gym settings.", error);
        }
    }

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String data = call.getString("data");

        if (filename == null || filename.trim().isEmpty() || data == null || data.isEmpty()) {
            call.reject("The recording file is incomplete.");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("legacyStorage", call, "legacyStorageCallback");
            return;
        }

        saveRecording(call);
    }

    @PermissionCallback
    private void legacyStorageCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("Storage access is required to save the recording to Downloads.");
            return;
        }
        saveRecording(call);
    }

    private void saveRecording(PluginCall call) {
        try {
            String filename = call.getString("filename");
            String mimeType = call.getString("mimeType", "application/octet-stream");
            byte[] bytes = Base64.decode(call.getString("data"), Base64.DEFAULT);

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                saveLegacyDownload(call, filename, bytes);
                return;
            }

            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Speakers Gym");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);

            ContentResolver resolver = getContext().getContentResolver();
            Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri fileUri = resolver.insert(collection, values);
            if (fileUri == null) {
                call.reject("Android could not create the file in Downloads.");
                return;
            }

            try (OutputStream output = resolver.openOutputStream(fileUri)) {
                if (output == null) throw new IllegalStateException("Android could not open the Downloads file.");
                output.write(bytes);
                output.flush();
            } catch (Exception error) {
                resolver.delete(fileUri, null, null);
                throw error;
            }

            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(fileUri, values, null, null);

            resolveSaved(call, filename, fileUri.toString());
        } catch (Exception error) {
            call.reject("Could not save the recording to Downloads.", error);
        }
    }

    private void saveLegacyDownload(PluginCall call, String filename, byte[] bytes) throws Exception {
        File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Speakers Gym");
        if (!folder.exists() && !folder.mkdirs()) {
            throw new IllegalStateException("Android could not create the Speakers Gym folder in Downloads.");
        }

        File file = new File(folder, filename);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.flush();
        }
        resolveSaved(call, filename, Uri.fromFile(file).toString());
    }

    private void resolveSaved(PluginCall call, String filename, String uri) {
        JSObject result = new JSObject();
        result.put("filename", filename);
        result.put("folder", "Downloads/Speakers Gym");
        result.put("uri", uri);
        call.resolve(result);
    }
}
