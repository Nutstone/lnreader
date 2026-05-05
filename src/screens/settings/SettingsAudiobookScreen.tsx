import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from 'react-native-paper';

import { Appbar, List, SafeAreaView } from '@components';
import { useTheme, useAudiobookSettings } from '@hooks/persisted';
import { getString } from '@strings/translations';
import { AudiobookSettingsScreenProps } from '@navigators/types';
import { Pressable } from 'react-native';

const providers = [
  { key: 'anthropic' as const, label: 'audiobookSettings.providerAnthropic' },
  { key: 'gemini' as const, label: 'audiobookSettings.providerGemini' },
  { key: 'ollama' as const, label: 'audiobookSettings.providerOllama' },
] as const;

const ttsPrecisions = [
  { key: 'q8' as const, label: 'q8 (Fastest)' },
  { key: 'fp16' as const, label: 'fp16 (Balanced)' },
  { key: 'fp32' as const, label: 'fp32 (Best)' },
] as const;

const AudiobookSettingsScreen = ({
  navigation,
}: AudiobookSettingsScreenProps) => {
  const theme = useTheme();
  const {
    llmProvider,
    apiKey,
    baseUrl,
    model,
    ttsPrecision,
    lookaheadSegments,
    mainCharacterEmotionalSlots,
    setAudiobookSettings,
  } = useAudiobookSettings();

  const [apiKeyInput, setApiKeyInput] = useState(apiKey);
  const [baseUrlInput, setBaseUrlInput] = useState(baseUrl);
  const [modelInput, setModelInput] = useState(model);
  const [lookaheadInput, setLookaheadInput] = useState(
    String(lookaheadSegments),
  );
  const [slotsInput, setSlotsInput] = useState(
    String(mainCharacterEmotionalSlots),
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

        <List.Section>
          <List.SubHeader theme={theme}>
            {getString('audiobookSettings.apiKey')}
          </List.SubHeader>
          <View style={styles.inputContainer}>
            <TextInput
              mode="outlined"
              value={apiKeyInput}
              onChangeText={setApiKeyInput}
              onBlur={() => setAudiobookSettings({ apiKey: apiKeyInput })}
              secureTextEntry
              theme={{ colors: { ...theme } }}
              style={styles.textInput}
              dense
            />
          </View>
        </List.Section>

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
                onBlur={() => setAudiobookSettings({ baseUrl: baseUrlInput })}
                placeholder="http://localhost:11434"
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
              onBlur={() => setAudiobookSettings({ model: modelInput })}
              placeholder="Optional model override"
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
  inputContainer: {
    paddingHorizontal: 16,
  },
  paddingBottom: { paddingBottom: 40 },
  textInput: {
    fontSize: 14,
  },
});
