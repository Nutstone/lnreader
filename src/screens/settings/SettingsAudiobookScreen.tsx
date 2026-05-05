/**
 * Audiobook Settings.
 *
 * Single Anthropic provider, single TTS engine. Just the knobs that
 * actually affect playback.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from 'react-native-paper';

import { Appbar, Button, List, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import { useAudiobookSettings } from '@hooks/persisted/useAudiobookSettings';
import { AudiobookSettingsScreenProps } from '@navigators/types';
import { LLMAnnotator } from '@services/audiobook/llmAnnotator';
import { AudioCache } from '@services/audiobook/audioCache';
import { KokoroDtype } from '@services/audiobook';
import { showToast } from '@utils/showToast';

const audioCache = new AudioCache();
const DTYPES: KokoroDtype[] = ['q4', 'q4f16', 'q8', 'fp16', 'fp32'];

const AudiobookSettingsScreen = ({
  navigation,
}: AudiobookSettingsScreenProps) => {
  const theme = useTheme();
  const settings = useAudiobookSettings();

  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState<'idle' | 'pending' | 'ok' | 'fail'>(
    'idle',
  );
  const [testMessage, setTestMessage] = useState<string>('');

  const testConnection = async () => {
    setTesting('pending');
    setTestMessage('');
    try {
      const annotator = new LLMAnnotator({ apiKey, model: settings.model });
      await annotator.buildGlossary('test', [
        'test sample for connection check',
      ]);
      setTesting('ok');
      setTestMessage('Connected.');
    } catch (e) {
      setTesting('fail');
      setTestMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title="Audiobook"
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      <ScrollView
        style={[{ backgroundColor: theme.background }, styles.flex]}
        contentContainerStyle={styles.padding}
      >
        <Card theme={theme}>
          <Text style={[styles.heroTitle, { color: theme.onSurface }]}>
            Multi-voice narration
          </Text>
          <Text style={[styles.heroBody, { color: theme.onSurfaceVariant }]}>
            Claude annotates each chapter into per-character segments. Audio
            is rendered on-device by Kokoro and cached so replays work
            offline.
          </Text>
        </Card>

        <Section title="Claude API key" theme={theme}>
          <View style={styles.inputRow}>
            <TextInput
              mode="outlined"
              value={apiKey}
              onChangeText={setApiKey}
              onBlur={() => settings.setAudiobookSettings({ apiKey })}
              secureTextEntry={!showKey}
              placeholder="sk-ant-…"
              style={styles.flex}
              dense
              theme={{ colors: { ...theme } }}
            />
            <Pressable
              style={styles.eyeBtn}
              onPress={() => setShowKey(s => !s)}
            >
              <Text style={{ color: theme.primary }}>
                {showKey ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.help, { color: theme.onSurfaceVariant }]}>
            Stored locally. Get a key at console.anthropic.com.
          </Text>
        </Section>

        <Section title="Test connection" theme={theme}>
          <View style={styles.testRow}>
            <Button
              title={testing === 'pending' ? 'Testing…' : 'Test'}
              mode="outlined"
              onPress={testConnection}
            />
            {testing !== 'idle' ? (
              <Text
                numberOfLines={3}
                style={[
                  styles.testMsg,
                  {
                    color:
                      testing === 'ok'
                        ? theme.primary
                        : testing === 'fail'
                          ? theme.error ?? '#cc3333'
                          : theme.onSurfaceVariant,
                  },
                ]}
              >
                {testMessage}
              </Text>
            ) : null}
          </View>
        </Section>

        <Section title="Voice quality" theme={theme}>
          <View style={styles.chipRow}>
            {DTYPES.map(q => (
              <Chip
                key={q}
                label={q}
                active={settings.ttsDtype === q}
                onPress={() => settings.setAudiobookSettings({ ttsDtype: q })}
                theme={theme}
              />
            ))}
          </View>
          <Text style={[styles.help, { color: theme.onSurfaceVariant }]}>
            Trade-off between size and quality. q8 is the default.
          </Text>
        </Section>

        <Section title="Lookahead segments" theme={theme}>
          <View style={styles.chipRow}>
            {[1, 2, 3, 4, 5, 6].map(n => (
              <Chip
                key={n}
                label={String(n)}
                active={settings.lookaheadSegments === n}
                onPress={() =>
                  settings.setAudiobookSettings({ lookaheadSegments: n })
                }
                theme={theme}
              />
            ))}
          </View>
          <Text style={[styles.help, { color: theme.onSurfaceVariant }]}>
            How many segments to render ahead of playback. Higher = smoother
            playback but more RAM/CPU.
          </Text>
        </Section>

        <Section title="Playback" theme={theme}>
          <Toggle
            label="Auto-advance to next chapter"
            value={settings.autoAdvanceChapter}
            onChange={v =>
              settings.setAudiobookSettings({ autoAdvanceChapter: v })
            }
            theme={theme}
          />
          <Toggle
            label="Emotion shaping (volume gain on whisper / shouting)"
            value={settings.emotionShaping}
            onChange={v => settings.setAudiobookSettings({ emotionShaping: v })}
            theme={theme}
          />
        </Section>

        <Section title="Rendered audio" theme={theme}>
          <Text style={[styles.help, { color: theme.onSurfaceVariant }]}>
            Drop the rendered WAVs for every novel to free up space.
            Annotations and voice maps stay (they cost real LLM money).
            To wipe everything for one novel, use the headphones menu on
            its detail screen.
          </Text>
          <View style={styles.cacheBtns}>
            <Button
              title="Clear rendered audio"
              mode="outlined"
              onPress={() => {
                audioCache.clearAll();
                showToast('Rendered audio cleared');
              }}
            />
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
};

const Card: React.FC<{
  children: React.ReactNode;
  theme: ReturnType<typeof useTheme>;
}> = ({ children, theme }) => (
  <View
    style={[
      styles.card,
      { backgroundColor: theme.surface, borderColor: theme.outline },
    ]}
  >
    {children}
  </View>
);

const Section: React.FC<{
  title: string;
  children: React.ReactNode;
  theme: ReturnType<typeof useTheme>;
}> = ({ title, children, theme }) => (
  <View style={styles.section}>
    <List.SubHeader theme={theme}>{title}</List.SubHeader>
    <View style={styles.sectionBody}>{children}</View>
  </View>
);

const Chip: React.FC<{
  label: string;
  active: boolean;
  onPress: () => void;
  theme: ReturnType<typeof useTheme>;
}> = ({ label, active, onPress, theme }) => (
  <Pressable
    onPress={onPress}
    style={[
      styles.chip,
      { backgroundColor: active ? theme.primary : theme.surfaceVariant },
    ]}
  >
    <Text
      style={{ color: active ? theme.onPrimary : theme.onSurfaceVariant }}
    >
      {label}
    </Text>
  </Pressable>
);

const Toggle: React.FC<{
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  theme: ReturnType<typeof useTheme>;
}> = ({ label, value, onChange, theme }) => (
  <Pressable onPress={() => onChange(!value)} style={styles.toggle}>
    <Text style={{ color: theme.onSurface, flex: 1 }}>{label}</Text>
    <View
      style={[
        styles.toggleBox,
        {
          backgroundColor: value ? theme.primary : theme.surfaceVariant,
          borderColor: theme.outline,
        },
      ]}
    >
      {value ? <Text style={{ color: theme.onPrimary }}>✓</Text> : null}
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  flex: { flex: 1 },
  padding: { paddingVertical: 8, paddingBottom: 60 },
  card: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  heroTitle: { fontSize: 18, fontWeight: '700' },
  heroBody: { fontSize: 13, marginTop: 6, lineHeight: 18 },
  section: { marginVertical: 8 },
  sectionBody: { paddingHorizontal: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16 },
  help: { fontSize: 12, marginTop: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eyeBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  testRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  testMsg: { fontSize: 12, flex: 1 },
  cacheBtns: { flexDirection: 'row', gap: 8, marginTop: 8 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleBox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});

export default AudiobookSettingsScreen;
