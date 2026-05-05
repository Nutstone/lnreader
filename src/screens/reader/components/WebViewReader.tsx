import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  StatusBar,
} from 'react-native';
import WebView from 'react-native-webview';
import color from 'color';

import { useTheme } from '@hooks/persisted';
import { getString } from '@strings/translations';

import { getPlugin } from '@plugins/pluginManager';
import { MMKVStorage, getMMKVObject } from '@utils/mmkv/mmkv';
import {
  CHAPTER_GENERAL_SETTINGS,
  CHAPTER_READER_SETTINGS,
  ChapterGeneralSettings,
  ChapterReaderSettings,
  initialChapterGeneralSettings,
  initialChapterReaderSettings,
} from '@hooks/persisted/useSettings';
import { getBatteryLevelSync } from 'react-native-device-info';
import * as Speech from 'expo-speech';
import { PLUGIN_STORAGE } from '@utils/Storages';
import { audiobookPlayer } from '@services/audiobook/AudiobookPlayer';
import { useAudiobookSettings } from '@hooks/persisted/useAudiobookSettings';
import { useChapterContext } from '../ChapterContext';
import {
  showTTSNotification,
  updateTTSNotification,
  updateTTSPlaybackState,
  updateTTSProgress,
  dismissTTSNotification,
  ttsMediaEmitter,
} from '@utils/ttsNotification';

type WebViewPostEvent = {
  type: string;
  data?: { [key: string]: unknown };
  autoStartTTS?: boolean;
  index?: number;
  total?: number;
};

type WebViewReaderProps = {
  onPress(): void;
};

const onLogMessage = (payload: { nativeEvent: { data: string } }) => {
  const dataPayload = JSON.parse(payload.nativeEvent.data);
  if (dataPayload) {
    if (dataPayload.type === 'console') {
      /* eslint-disable no-console */
      console.info(`[Console] ${JSON.stringify(dataPayload.msg, null, 2)}`);
    }
  }
};

const { RNDeviceInfo } = NativeModules;
const deviceInfoEmitter = new NativeEventEmitter(RNDeviceInfo);

const assetsUriPrefix = __DEV__
  ? 'http://localhost:8081/assets'
  : 'file:///android_asset';

const WebViewReader: React.FC<WebViewReaderProps> = ({ onPress }) => {
  const {
    novel,
    chapter,
    chapterText: html,
    navigateChapter,
    saveProgress,
    nextChapter,
    prevChapter,
    webViewRef,
  } = useChapterContext();
  const theme = useTheme();
  // Use state for settings so they update when MMKV changes
  const [readerSettings, setReaderSettings] = useState<ChapterReaderSettings>(
    () =>
      getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
      initialChapterReaderSettings,
  );
  const chapterGeneralSettings = useMemo(
    () =>
      getMMKVObject<ChapterGeneralSettings>(CHAPTER_GENERAL_SETTINGS) ||
      initialChapterGeneralSettings,
    // needed to preserve settings during chapter change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chapter.id],
  );

  // Update readerSettings when chapter changes
  useEffect(() => {
    setReaderSettings(
      getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
      initialChapterReaderSettings,
    );
  }, [chapter.id]);

  // Update battery level when chapter changes to ensure fresh value on navigation
  const batteryLevel = useMemo(() => getBatteryLevelSync(), []);
  const plugin = getPlugin(novel?.pluginId);
  const pluginCustomJS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.js`;
  const pluginCustomCSS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.css`;
  const nextChapterScreenVisible = useRef<boolean>(false);
  const autoStartTTSRef = useRef<boolean>(false);
  const autoStartAudiobookRef = useRef<boolean>(false);
  const isTTSReadingRef = useRef<boolean>(false);
  const isAudiobookActiveRef = useRef<boolean>(false);
  const readerSettingsRef = useRef<ChapterReaderSettings>(readerSettings);
  const appStateRef = useRef(AppState.currentState);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsQueueIndexRef = useRef<number>(0);
  const audiobookSettings = useAudiobookSettings();

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  // Subscribe to the global audiobook player. Updates highlighting,
  // notification metadata, and auto-advance from a single subscription.
  useEffect(() => {
    let lastSegmentIndex = -1;
    let reachedEnd = false;
    const unsubscribe = audiobookPlayer.subscribe(state => {
      const isActive =
        state.status === 'playing' ||
        state.status === 'paused' ||
        state.status === 'rendering' ||
        state.status === 'loading';
      isAudiobookActiveRef.current = isActive;

      if (state.status === 'playing' || state.status === 'paused') {
        updateTTSPlaybackState(state.status === 'playing');
      }

      if (
        state.segmentIndex !== lastSegmentIndex &&
        state.totalSegments > 0 &&
        state.currentText
      ) {
        lastSegmentIndex = state.segmentIndex;
        // Detect "reached the last segment" — only auto-advance after
        // we've actually played through to the end. Manual stops won't
        // trigger this.
        if (state.segmentIndex >= state.totalSegments - 1) {
          reachedEnd = true;
        }
        updateTTSProgress(state.segmentIndex, state.totalSegments);
        updateTTSNotification({
          novelName: novel?.name || 'Unknown',
          chapterName: `${chapter.name} — ${state.currentSpeaker ?? ''}`,
          coverUri: novel?.cover || '',
          isPlaying: state.status === 'playing',
        });
        const escaped = state.currentText
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(/\n/g, '\\n');
        webViewRef.current?.injectJavaScript(
          `if (window.audiobook && window.audiobook.highlightSegment) { audiobook.highlightSegment('${escaped}'); }`,
        );
      }

      if (state.status === 'idle' && reachedEnd) {
        reachedEnd = false;
        lastSegmentIndex = -1;
        const autoAdvance = audiobookSettings.autoAdvanceChapter === true;
        if (autoAdvance && nextChapter) {
          autoStartAudiobookRef.current = true;
          navigateChapter('NEXT');
        } else {
          dismissTTSNotification();
          webViewRef.current?.injectJavaScript(
            'if (window.audiobook) { audiobook.stop(); }',
          );
        }
      }

      if (state.status === 'error' && state.error) {
        dismissTTSNotification();
        webViewRef.current?.injectJavaScript(
          `if (window.audiobook) { audiobook.started = false; audiobook.playing = false; }`,
        );
      }
    });

    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id, novel?.name, novel?.cover, chapter.name, nextChapter]);

  useEffect(() => {
    const playListener = ttsMediaEmitter.addListener('TTSPlay', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.resume();
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts && !tts.reading) { tts.resume(); }
        `);
      }
    });
    const pauseListener = ttsMediaEmitter.addListener('TTSPause', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.pause();
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts && tts.reading) { tts.pause(); }
        `);
      }
    });
    const stopListener = ttsMediaEmitter.addListener('TTSStop', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.stop();
        webViewRef.current?.injectJavaScript(
          'if (window.audiobook) { audiobook.started = false; audiobook.playing = false; }',
        );
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts) { tts.stop(); }
        `);
      }
    });
    const rewindListener = ttsMediaEmitter.addListener('TTSRewind', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.seekToSegment(0);
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts && tts.started) { tts.rewind(); }
        `);
      }
    });
    const prevListener = ttsMediaEmitter.addListener('TTSPrev', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.stop();
        webViewRef.current?.injectJavaScript(
          'if (window.audiobook) { audiobook.started = false; audiobook.playing = false; }',
        );
        autoStartAudiobookRef.current = true;
        navigateChapter('PREV');
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts && window.reader && window.reader.prevChapter) {
            window.reader.post({ type: 'prev', autoStartTTS: true });
          }
        `);
      }
    });
    const nextListener = ttsMediaEmitter.addListener('TTSNext', () => {
      if (isAudiobookActiveRef.current) {
        audiobookPlayer.stop();
        webViewRef.current?.injectJavaScript(
          'if (window.audiobook) { audiobook.started = false; audiobook.playing = false; }',
        );
        autoStartAudiobookRef.current = true;
        navigateChapter('NEXT');
      } else {
        webViewRef.current?.injectJavaScript(`
          if (window.tts && window.reader && window.reader.nextChapter) {
            window.reader.post({ type: 'next', autoStartTTS: true });
          }
        `);
      }
    });
    const seekToListener = ttsMediaEmitter.addListener(
      'TTSSeekTo',
      (event: { position: number }) => {
        const position = event.position;
        if (isAudiobookActiveRef.current) {
          audiobookPlayer.seekToSegment(position);
        } else {
          webViewRef.current?.injectJavaScript(`
            if (window.tts && tts.started) { tts.seekTo(${position}); }
          `);
        }
      },
    );
    return () => {
      playListener.remove();
      pauseListener.remove();
      stopListener.remove();
      rewindListener.remove();
      prevListener.remove();
      nextListener.remove();
      seekToListener.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webViewRef]);

  useEffect(() => {
    if (isTTSReadingRef.current) {
      updateTTSNotification({
        novelName: novel?.name || 'Unknown',
        chapterName: chapter.name,
        coverUri: novel?.cover || '',
        isPlaying: isTTSReadingRef.current,
      });
    }
  }, [novel?.name, novel?.cover, chapter.name]);

  useEffect(() => {
    return () => {
      audiobookPlayer.stop();
      dismissTTSNotification();
    };
  }, []);

  useEffect(() => {
    const mmkvListener = MMKVStorage.addOnValueChangedListener(key => {
      switch (key) {
        case CHAPTER_READER_SETTINGS:
          // Update local state with new settings
          const newSettings =
            getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
            initialChapterReaderSettings;
          setReaderSettings(newSettings);

          // Stop any currently playing speech
          Speech.stop();

          // Update WebView settings
          webViewRef.current?.injectJavaScript(
            `
            reader.readerSettings.val = ${MMKVStorage.getString(
              CHAPTER_READER_SETTINGS,
            )};
            // Auto-restart TTS if currently reading
            if (window.tts && tts.reading) {
              const currentElement = tts.currentElement;
              const wasReading = tts.reading;
              tts.stop();
              if (wasReading) {
                setTimeout(() => {
                  tts.start(currentElement);
                }, 100);
              }
            }
            `,
          );
          break;
        case CHAPTER_GENERAL_SETTINGS: {
          const newGeneralSettings =
            getMMKVObject<ChapterGeneralSettings>(CHAPTER_GENERAL_SETTINGS) ||
            initialChapterGeneralSettings;
          // Stop audiobook if it was disabled
          if (
            !newGeneralSettings.AudiobookEnable &&
            isAudiobookActiveRef.current
          ) {
            audiobookPlayer.stop();
            isAudiobookActiveRef.current = false;
            dismissTTSNotification();
          }
          webViewRef.current?.injectJavaScript(
            `reader.generalSettings.val = ${MMKVStorage.getString(
              CHAPTER_GENERAL_SETTINGS,
            )}`,
          );
          break;
        }
      }
    });

    const subscription = deviceInfoEmitter.addListener(
      'RNDeviceInfo_batteryLevelDidChange',
      (level: number) => {
        webViewRef.current?.injectJavaScript(
          `reader.batteryLevel.val = ${level}`,
        );
      },
    );
    return () => {
      subscription.remove();
      mmkvListener.remove();
    };
  }, [webViewRef]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      appStateRef.current = nextState;
      if (nextState === 'active' && isTTSReadingRef.current) {
        const index = ttsQueueIndexRef.current;
        webViewRef.current?.injectJavaScript(`
          if (window.tts && window.tts.allReadableElements) {
            const idx = ${index};
            if (idx < tts.allReadableElements.length) {
              tts.elementsRead = idx;
              tts.currentElement = tts.allReadableElements[idx];
              tts.prevElement = null;
              tts.started = true;
              tts.reading = true;
              tts.scrollToElement(tts.currentElement);
              tts.currentElement.classList.add('highlight');
            }
          }
        `);
      }
    });

    return () => subscription.remove();
  }, [webViewRef]);

  const speakText = (text: string) => {
    Speech.speak(text, {
      onDone() {
        const isBackground =
          appStateRef.current === 'background' ||
          appStateRef.current === 'inactive';

        if (
          isBackground &&
          ttsQueueRef.current.length > 0 &&
          ttsQueueIndexRef.current + 1 < ttsQueueRef.current.length
        ) {
          const nextIndex = ttsQueueIndexRef.current + 1;
          const nextText = ttsQueueRef.current[nextIndex];
          if (nextText) {
            ttsQueueIndexRef.current = nextIndex;
            speakText(nextText);
            return;
          }
        }

        if (isBackground) {
          isTTSReadingRef.current = false;
          dismissTTSNotification();
          webViewRef.current?.injectJavaScript('tts.stop?.()');
          return;
        }

        webViewRef.current?.injectJavaScript('tts.next?.()');
      },
      voice: readerSettingsRef.current.tts?.voice?.identifier,
      pitch: readerSettingsRef.current.tts?.pitch || 1,
      rate: readerSettingsRef.current.tts?.rate || 1,
    });
  };
  const isRTL = plugin?.lang === 'Arabic' || plugin?.lang === 'Hebrew';
  const readerDir = isRTL ? 'rtl' : 'ltr';

  return (
    <WebView
      ref={webViewRef}
      style={{ backgroundColor: readerSettings.theme }}
      allowFileAccess={true}
      originWhitelist={['*']}
      scalesPageToFit={true}
      showsVerticalScrollIndicator={false}
      javaScriptEnabled={true}
      webviewDebuggingEnabled={__DEV__}
      onLoadEnd={() => {
        // Update battery level when WebView finishes loading
        const currentBatteryLevel = getBatteryLevelSync();
        webViewRef.current?.injectJavaScript(
          `if (window.reader && window.reader.batteryLevel) {
            window.reader.batteryLevel.val = ${currentBatteryLevel};
          }`,
        );

        if (autoStartTTSRef.current) {
          autoStartTTSRef.current = false;
          setTimeout(() => {
            webViewRef.current?.injectJavaScript(`
              (function() {
                if (window.tts && reader.generalSettings.val.TTSEnable) {
                  setTimeout(() => {
                    tts.start();
                    const controller = document.getElementById('TTS-Controller');
                    if (controller && controller.firstElementChild) {
                      controller.firstElementChild.innerHTML = pauseIcon;
                    }
                  }, 500);
                }
              })();
            `);
          }, 300);
        }

        if (autoStartAudiobookRef.current) {
          autoStartAudiobookRef.current = false;
          setTimeout(() => {
            webViewRef.current?.injectJavaScript(`
              (function() {
                if (window.audiobook && reader.generalSettings.val.AudiobookEnable) {
                  setTimeout(() => {
                    audiobook.start();
                    var controller = document.getElementById('TTS-Controller');
                    if (controller && controller.firstElementChild) {
                      controller.firstElementChild.innerHTML = pauseIcon;
                    }
                  }, 500);
                }
              })();
            `);
          }, 300);
        }
      }}
      onMessage={(ev: { nativeEvent: { data: string } }) => {
        __DEV__ && onLogMessage(ev);
        const event: WebViewPostEvent = JSON.parse(ev.nativeEvent.data);
        switch (event.type) {
          case 'tts-queue': {
            const payload = event.data as
              | { queue?: unknown; startIndex?: unknown }
              | undefined;
            const queue = Array.isArray(payload?.queue)
              ? payload?.queue.filter(
                (item): item is string =>
                  typeof item === 'string' && item.trim().length > 0,
              )
              : [];
            ttsQueueRef.current = queue;
            if (typeof payload?.startIndex === 'number') {
              ttsQueueIndexRef.current = payload.startIndex;
            } else {
              ttsQueueIndexRef.current = 0;
            }
            break;
          }
          case 'hide':
            onPress();
            break;
          case 'next':
            nextChapterScreenVisible.current = true;
            if (event.autoStartTTS) {
              autoStartTTSRef.current = true;
            }
            navigateChapter('NEXT');
            break;
          case 'prev':
            if (event.autoStartTTS) {
              autoStartTTSRef.current = true;
            }
            navigateChapter('PREV');
            break;
          case 'save':
            if (event.data && typeof event.data === 'number') {
              saveProgress(event.data);
            }
            break;
          case 'speak':
            if (event.data && typeof event.data === 'string') {
              if (typeof event.index === 'number') {
                ttsQueueIndexRef.current = event.index;
              }
              if (!isTTSReadingRef.current) {
                isTTSReadingRef.current = true;
                showTTSNotification({
                  novelName: novel?.name || 'Unknown',
                  chapterName: chapter.name,
                  coverUri: novel?.cover || '',
                  isPlaying: true,
                });
              } else {
                updateTTSNotification({
                  novelName: novel?.name || 'Unknown',
                  chapterName: chapter.name,
                  coverUri: novel?.cover || '',
                  isPlaying: true,
                });
              }
              if (
                typeof event.index === 'number' &&
                typeof event.total === 'number' &&
                event.total > 0
              ) {
                updateTTSProgress(event.index, event.total);
              }
              speakText(event.data);
            } else {
              webViewRef.current?.injectJavaScript('tts.next?.()');
            }
            break;
          case 'pause-speak':
            Speech.stop();
            break;
          case 'stop-speak':
            Speech.stop();
            if (!autoStartTTSRef.current) {
              isTTSReadingRef.current = false;
              ttsQueueRef.current = [];
              ttsQueueIndexRef.current = 0;
              dismissTTSNotification();
            }
            break;
          case 'tts-state':
            if (event.data && typeof event.data === 'object') {
              const data = event.data as { isReading?: boolean };
              const isReading = data.isReading === true;
              isTTSReadingRef.current = isReading;
              updateTTSPlaybackState(isReading);
            }
            break;
          case 'audiobook-start':
            if (event.data && typeof event.data === 'string') {
              isAudiobookActiveRef.current = true;
              audiobookPlayer.playChapter(
                {
                  novelId: String(novel?.id ?? ''),
                  llm: {
                    apiKey: audiobookSettings.apiKey,
                    model: audiobookSettings.model,
                  },
                  tts: {
                    playbackSpeed: 1.0,
                    emotionShaping: audiobookSettings.emotionShaping,
                    lookaheadSegments: audiobookSettings.lookaheadSegments,
                    dtype: audiobookSettings.ttsDtype,
                  },
                },
                {
                  id: novel?.id ?? '',
                  name: novel?.name ?? 'Unknown',
                  cover: novel?.cover ?? undefined,
                },
                {
                  id: chapter.id,
                  path: chapter.path,
                  name: chapter.name,
                },
                event.data,
              );
            }
            break;
          case 'audiobook-pause':
            audiobookPlayer.pause();
            break;
          case 'audiobook-resume':
            audiobookPlayer.resume();
            break;
          case 'audiobook-stop':
            audiobookPlayer.stop();
            isAudiobookActiveRef.current = false;
            dismissTTSNotification();
            break;
        }
      }}
      source={{
        baseUrl: !chapter.isDownloaded ? plugin?.site : undefined,
        headers: plugin?.imageRequestInit?.headers,
        method: plugin?.imageRequestInit?.method,
        body: plugin?.imageRequestInit?.body,
        html: ` 
        <!DOCTYPE html>
          <html dir="${readerDir}">
            <head>
              <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/index.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/pageReader.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/toolWrapper.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/tts.css">
              <style>
              :root {
                --StatusBar-currentHeight: ${StatusBar.currentHeight}px;
                --readerSettings-theme: ${readerSettings.theme};
                --readerSettings-padding: ${readerSettings.padding}px;
                --readerSettings-textSize: ${readerSettings.textSize}px;
                --readerSettings-textColor: ${readerSettings.textColor};
                --readerSettings-textAlign: ${readerSettings.textAlign};
                --readerSettings-lineHeight: ${readerSettings.lineHeight};
                --readerSettings-fontFamily: ${readerSettings.fontFamily};
                --theme-primary: ${theme.primary};
                --theme-onPrimary: ${theme.onPrimary};
                --theme-secondary: ${theme.secondary};
                --theme-tertiary: ${theme.tertiary};
                --theme-onTertiary: ${theme.onTertiary};
                --theme-onSecondary: ${theme.onSecondary};
                --theme-surface: ${theme.surface};
                --theme-surface-0-9: ${color(theme.surface)
            .alpha(0.9)
            .toString()};
                --theme-onSurface: ${theme.onSurface};
                --theme-surfaceVariant: ${theme.surfaceVariant};
                --theme-onSurfaceVariant: ${theme.onSurfaceVariant};
                --theme-outline: ${theme.outline};
                --theme-rippleColor: ${theme.rippleColor};
                }
                
                @font-face {
                  font-family: ${readerSettings.fontFamily};
                  src: url("file:///android_asset/fonts/${readerSettings.fontFamily
          }.ttf");
                }
                </style>
 
              <link rel="stylesheet" href="${pluginCustomCSS}">
              <style>${readerSettings.customCSS}</style>
            </head>
            <body class="${chapterGeneralSettings.pageReader ? 'page-reader' : ''
          }">
              <div class="transition-chapter" style="transform: ${nextChapterScreenVisible.current
            ? 'translateX(-100%)'
            : 'translateX(0%)'
          };
              ${chapterGeneralSettings.pageReader ? '' : 'display: none'}"
              ">${chapter.name}</div>
              <div id="LNReader-chapter">
                ${html}  
              </div>
              <div id="reader-ui"></div>
              </body>
              <script>
                var initialPageReaderConfig = ${JSON.stringify({
            nextChapterScreenVisible: nextChapterScreenVisible.current,
          })};
 
 
                var initialReaderConfig = ${JSON.stringify({
            readerSettings,
            chapterGeneralSettings,
            novel,
            chapter,
            nextChapter,
            prevChapter,
            batteryLevel,
            autoSaveInterval: 2222,
            DEBUG: __DEV__,
            strings: {
              finished: getString('readerScreen.finished') + ': ' + chapter.name.trim(),
              nextChapter: getString('readerScreen.nextChapter', {
                name: nextChapter?.name,
              }),
              noNextChapter: getString('readerScreen.noNextChapter'),
            },
          })}
              </script>
              <script src="${assetsUriPrefix}/js/polyfill-onscrollend.js"></script>
              <script src="${assetsUriPrefix}/js/icons.js"></script>
              <script src="${assetsUriPrefix}/js/van.js"></script>
              <script src="${assetsUriPrefix}/js/text-vibe.js"></script>
              <script src="${assetsUriPrefix}/js/core.js"></script>
              <script src="${assetsUriPrefix}/js/index.js"></script>
              <script src="${pluginCustomJS}"></script>
              <script>
                ${readerSettings.customJS}
              </script>
          </html>
          `,
      }}
    />
  );
};

export default memo(WebViewReader);
