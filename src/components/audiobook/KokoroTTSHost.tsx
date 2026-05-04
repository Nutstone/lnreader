/**
 * KokoroTTSHost — invisible WebView that hosts the Kokoro TTS engine.
 *
 * Mounted globally in App.tsx. While mounted, the renderer's
 * `setKokoroHost` bridge is active and synthesis works. When unmounted
 * the bridge is cleared and the renderer can't run.
 *
 * The WebView is 1×1 px, off-screen, opacity 0 — invisible but present
 * in the layout tree so its JS runtime stays alive while the player is
 * active.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  KokoroHostBridge,
  KokoroHostMessage,
  setKokoroHost,
} from '@services/audiobook/renderers/KokoroWebViewRenderer';

interface Props {
  /** Whether the host is active (mount/unmount the WebView). */
  active: boolean;
}

const HTML_PATH = 'file:///android_asset/audiobook/kokoro-tts.html';

const KokoroTTSHost: React.FC<Props> = ({ active }) => {
  const webRef = useRef<WebView>(null);
  const handlersRef = useRef<Set<(msg: KokoroHostMessage) => void>>(new Set());

  const bridge = useMemo<KokoroHostBridge>(
    () => ({
      post: (payload: object) => {
        const json = JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        webRef.current?.injectJavaScript(
          `window.dispatchEvent(new MessageEvent('message', { data: '${json}' })); true;`,
        );
      },
      onMessage: (handler: (msg: KokoroHostMessage) => void) => {
        handlersRef.current.add(handler);
        return () => {
          handlersRef.current.delete(handler);
        };
      },
      isMounted: () => active,
    }),
    [active],
  );

  useEffect(() => {
    if (active) {
      setKokoroHost(bridge);
    } else {
      setKokoroHost(null);
    }
    return () => {
      setKokoroHost(null);
    };
  }, [active, bridge]);

  if (!active) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webRef}
        source={{ uri: HTML_PATH }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        onMessage={(e: WebViewMessageEvent) => {
          let msg: KokoroHostMessage | null = null;
          try {
            msg = JSON.parse(e.nativeEvent.data) as KokoroHostMessage;
          } catch {
            return;
          }
          for (const h of handlersRef.current) h(msg);
        }}
        style={styles.web}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 1,
    height: 1,
    left: -100,
    top: -100,
    opacity: 0,
  },
  web: { width: 1, height: 1 },
});

export default React.memo(KokoroTTSHost);
