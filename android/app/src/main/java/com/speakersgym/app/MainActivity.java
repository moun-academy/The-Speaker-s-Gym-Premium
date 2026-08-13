package com.speakersgym.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RecordingSaverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
