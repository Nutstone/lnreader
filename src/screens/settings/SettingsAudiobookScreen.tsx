import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Switch, Text, TextInput } from 'react-native-paper';
import { FileSystem } from 'react-native-file-access';

import { Appbar, List, SafeAreaView } from '@components';
import { useTheme, useAudiobookSettings } from '@hooks/persisted';
import { providerSettingsFor } from '@hooks/persisted/useAudiobookSettings';
import { DEFAULT_MODELS } from '@services/audiobook/llmAnnotator';
import { getString } from '@strings/translations';
import { AudiobookSettingsScreenProps } from '@navigators/types';
import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_CACHE_STORAGE } from '@utils/Storages';
import { showToast } from '@utils/showToast';

/** Model + voice-file directories (re-downloadable). */
const MODEL_DIRS = ['bundles', 'embeddings', 'voices'];
/** Rendered chapter audio (re-synthesizable). */
const AUDIO_DIR = 'audio';

const dirSize = async (path: string): Promise<number> => {
  if (!NativeFile.exists(path)) {
    return 0;
  }
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of NativeFile.readDir(dir)) {
      if (entry.isDirectory) {
        stack.push(entry.path);
      } else {
        try {
          total += (await FileSystem.stat(entry.path)).size ?? 0;
        } catch {
          // Files may vanish while we walk (cache eviction) — skip.
        }
      }
    }
  }
  return total;
};

const formatMB = (bytes: number | null): string =>
  bytes === null ? '…' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const providers = [
  { key: 'anthropic' as const, label: 'audiobookSettings.providerAnthropic' },
  { key: 'gemini' as const, label: 'audiobookSettings.providerGemini' },
  { key: 'ollama' as const, label: 'audiobookSettings.providerOllama' },
] as const;

const ttsPrecisions = [
  { key: 'int8' as const, label: 'int8 (Fast, ~150 MB)' },
  { key: 'fp32' as const, label: 'fp32 (Best, ~440 MB)' },
] as const;

const AudiobookSettingsScreen = ({
  navigation,
}: AudiobookSettingsScreenProps) => {
  const theme = useTheme();
  const {
    settings,
    llmProvider,
    ttsPrecision,
    lookaheadSegments,
    mainCharacterEmotionalSlots,
    renderDuringPrepare,
    setAudiobookSettings,
    setProviderSettings,
  } = useAudiobookSettings();

  const active = providerSettingsFor(settings, llmProvider);
  const [apiKeyInput, setApiKeyInput] = useState(active.apiKey);
  const [baseUrlInput, setBaseUrlInput] = useState(active.baseUrl);
  const [modelInput, setModelInput] = useState(active.model);
  const [lookaheadInput, setLookaheadInput] = useState(
    String(lookaheadSegments),
  );
  const [slotsInput, setSlotsInput] = useState(
    String(mainCharacterEmotionalSlots),
  );

  // Each provider keeps its own key/model/URL — swap the inputs when
  // the provider chip changes.
  useEffect(() => {
    const stored = providerSettingsFor(settings, llmProvider);
    setApiKeyInput(stored.apiKey);
    setBaseUrlInput(stored.baseUrl);
    setModelInput(stored.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llmProvider]);

  const [modelBytes, setModelBytes] = useState<number | null>(null);
  const [audioBytes, setAudioBytes] = useState<number | null>(null);

  const refreshStorage = useCallback(async () => {
    setModelBytes(null);
    setAudioBytes(null);
    let model = 0;
    for (const dir of MODEL_DIRS) {
      model += await dirSize(`${AUDIOBOOK_CACHE_STORAGE}/${dir}`);
    }
    setModelBytes(model);
    setAudioBytes(await dirSize(`${AUDIOBOOK_CACHE_STORAGE}/${AUDIO_DIR}`));
  }, []);

  useEffect(() => {
    refreshStorage();
  }, [refreshStorage]);

  const clearDirs = useCallback(
    (dirs: string[], what: string) => {
      for (const dir of dirs) {
        const path = `${AUDIOBOOK_CACHE_STORAGE}/${dir}`;
        if (NativeFile.exists(path)) {
          try {
            NativeFile.unlink(path);
          } catch {}
        }
      }
      showToast(`${what} deleted`);
      refreshStorage();
    },
    [refreshStorage],
  );

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title={getString('audiobookSettings.title')}
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      <ScrollView
        style={[{ backgroundColor: theme.background }, styles.flex]}
        contentContainerStyle={styles.paddingBottom}
      >
        <List.Section>
          <List.SubHeader theme={theme}>
            {getString('audiobookSettings.llmProvider')}
          </List.SubHeader>
          <View style={styles.chipRow}>
            {providers.map(p => (
              <Pressable
                key={p.key}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      llmProvider === p.key
                        ? theme.primary
                        : theme.surfaceVariant,
                  },
                ]}
                onPress={() => setAudiobookSettings({ llmProvider: p.key })}
              >
                <Text
                  style={{
                    color:
                      llmProvider === p.key
                        ? theme.onPrimary
                        : theme.onSurfaceVariant,
                  }}
                >
                  {getString(p.label)}
                </Text>
              </Pressable>
            ))}
          </View>
        </List.Section>

        {llmProvider !== 'ollama' ? (
          <List.Section>
            <List.SubHeader theme={theme}>
              {getString('audiobookSettings.apiKey')}
            </List.SubHeader>
            <View style={styles.inputContainer}>
              <TextInput
                mode="outlined"
                value={apiKeyInput}
                onChangeText={setApiKeyInput}
                onBlur={() =>
                  setProviderSettings(llmProvider, { apiKey: apiKeyInput })
                }
                secureTextEntry
                theme={{ colors: { ...theme } }}
                style={styles.textInput}
                dense
              />
              {llmProvider === 'gemini' ? (
                <Text
                  style={[styles.hint, { color: theme.onSurfaceVariant }]}
                  variant="bodySmall"
                >
                  Free-tier keys from aistudio.google.com work — no billing
                  account needed.
                </Text>
              ) : null}
            </View>
          </List.Section>
        ) : null}

        {llmProvider === 'ollama' ? (
          <List.Section>
            <List.SubHeader theme={theme}>
              {getString('audiobookSettings.baseUrl')}
            </List.SubHeader>
            <View style={styles.inputContainer}>
              <TextInput
                mode="outlined"
                value={baseUrlInput}
                onChangeText={setBaseUrlInput}
                onBlur={() =>
                  setProviderSettings(llmProvider, { baseUrl: baseUrlInput })
                }
                placeholder="http://192.168.1.10:11434"
                theme={{ colors: { ...theme } }}
                style={styles.textInput}
                dense
              />
            </View>
          </List.Section>
        ) : null}

        <List.Section>
          <List.SubHeader theme={theme}>
            {getString('audiobookSettings.model')}
          </List.SubHeader>
          <View style={styles.inputContainer}>
            <TextInput
              mode="outlined"
              value={modelInput}
              onChangeText={setModelInput}
              onBlur={() =>
                setProviderSettings(llmProvider, { model: modelInput })
              }
              placeholder={DEFAULT_MODELS[llmProvider]}
              theme={{ colors: { ...theme } }}
              style={styles.textInput}
              dense
            />
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>
            {getString('audiobookSettings.ttsQuality')}
          </List.SubHeader>
          <View style={styles.chipRow}>
            {ttsPrecisions.map(q => (
              <Pressable
                key={q.key}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      ttsPrecision === q.key
                        ? theme.primary
                        : theme.surfaceVariant,
                  },
                ]}
                onPress={() => setAudiobookSettings({ ttsPrecision: q.key })}
              >
                <Text
                  style={{
                    color:
                      ttsPrecision === q.key
                        ? theme.onPrimary
                        : theme.onSurfaceVariant,
                  }}
                >
                  {q.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>Prepare audiobook</List.SubHeader>
          <Pressable
            style={styles.switchRow}
            onPress={() =>
              setAudiobookSettings({
                renderDuringPrepare: !renderDuringPrepare,
              })
            }
          >
            <View style={styles.switchLabel}>
              <Text style={{ color: theme.onSurface }}>
                Render audio while preparing
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.onSurfaceVariant }}
              >
                'Prepare audiobook' also synthesizes the chapters' audio so
                playback starts instantly. Takes minutes per chapter and uses
                ~10 MB each.
              </Text>
            </View>
            <Switch
              value={renderDuringPrepare === true}
              onValueChange={value =>
                setAudiobookSettings({ renderDuringPrepare: value })
              }
              color={theme.primary}
            />
          </Pressable>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>
            {getString('audiobookSettings.lookaheadSegments')}
          </List.SubHeader>
          <View style={styles.inputContainer}>
            <TextInput
              mode="outlined"
              value={lookaheadInput}
              onChangeText={setLookaheadInput}
              onBlur={() => {
                const n = parseInt(lookaheadInput, 10);
                if (!isNaN(n) && n >= 0) {
                  setAudiobookSettings({ lookaheadSegments: n });
                }
              }}
              keyboardType="numeric"
              theme={{ colors: { ...theme } }}
              style={styles.textInput}
              dense
            />
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>Storage</List.SubHeader>
          <View style={styles.storageRow}>
            <View style={styles.switchLabel}>
              <Text style={{ color: theme.onSurface }}>
                TTS model & voice files
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.onSurfaceVariant }}
              >
                {formatMB(modelBytes)} — re-downloaded when needed
              </Text>
            </View>
            <Pressable
              onPress={() => clearDirs(MODEL_DIRS, 'Model & voice files')}
            >
              <Text style={{ color: theme.primary }}>Delete</Text>
            </Pressable>
          </View>
          <View style={styles.storageRow}>
            <View style={styles.switchLabel}>
              <Text style={{ color: theme.onSurface }}>Rendered audio</Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.onSurfaceVariant }}
              >
                {formatMB(audioBytes)} — re-synthesized when needed
              </Text>
            </View>
            <Pressable onPress={() => clearDirs([AUDIO_DIR], 'Rendered audio')}>
              <Text style={{ color: theme.primary }}>Delete</Text>
            </Pressable>
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>
            Main-character emotional voice slots
          </List.SubHeader>
          <View style={styles.inputContainer}>
            <TextInput
              mode="outlined"
              value={slotsInput}
              onChangeText={setSlotsInput}
              onBlur={() => {
                const n = parseInt(slotsInput, 10);
                if (!isNaN(n) && n >= 0) {
                  setAudiobookSettings({
                    mainCharacterEmotionalSlots: n,
                  });
                }
              }}
              keyboardType="numeric"
              theme={{ colors: { ...theme } }}
              style={styles.textInput}
              dense
            />
          </View>
        </List.Section>
      </ScrollView>
    </SafeAreaView>
  );
};

export default AudiobookSettingsScreen;

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
  },
  chip: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  flex: { flex: 1 },
  hint: {
    marginTop: 4,
  },
  inputContainer: {
    paddingHorizontal: 16,
  },
  paddingBottom: { paddingBottom: 40 },
  storageRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  switchLabel: {
    flex: 1,
    paddingRight: 16,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  textInput: {
    fontSize: 14,
  },
});
