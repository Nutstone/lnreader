/**
 * CostPreviewModal — shown before any batch annotation that will spend
 * cloud credits. Free local providers skip the modal.
 */

import React from 'react';
import { Modal, Portal } from 'react-native-paper';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@hooks/persisted';
import { CostEstimate } from '@services/audiobook';

interface Props {
  visible: boolean;
  estimate: CostEstimate | null;
  chapterCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

const CostPreviewModal: React.FC<Props> = ({
  visible,
  estimate,
  chapterCount,
  onCancel,
  onConfirm,
}) => {
  const theme = useTheme();
  if (!estimate) return null;

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onCancel}
        contentContainerStyle={[
          styles.sheet,
          { backgroundColor: theme.surface },
        ]}
      >
        <Text style={[styles.title, { color: theme.onSurface }]}>
          Process {chapterCount} chapter{chapterCount === 1 ? '' : 's'}?
        </Text>
        {estimate.isFree ? (
          <Text style={[styles.subtitle, { color: theme.onSurfaceVariant }]}>
            Local model: free.{estimate.notes ? ' ' + estimate.notes : ''}
          </Text>
        ) : (
          <View>
            <Row
              label="Provider / model"
              value={`${estimate.provider} · ${estimate.model}`}
              theme={theme}
            />
            <Row
              label="Tokens (in / out)"
              value={`${formatThousands(
                estimate.totalTokensIn,
              )} / ${formatThousands(estimate.totalTokensOut)}`}
              theme={theme}
            />
            <Row
              label="Cost (with cache)"
              value={`$${estimate.costUSDWithCache.toFixed(2)}`}
              theme={theme}
              emphasis
            />
            <Row
              label="Cost (no cache)"
              value={`$${estimate.costUSDWithoutCache.toFixed(2)}`}
              theme={theme}
            />
            <Text style={[styles.note, { color: theme.onSurfaceVariant }]}>
              Numbers are estimates. Actual cost depends on chapter length;
              expect ±20%.
            </Text>
          </View>
        )}

        <View style={styles.btns}>
          <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
            <Text style={{ color: theme.onSurface }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            style={[styles.confirmBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={{ color: theme.onPrimary, fontWeight: '600' }}>
              Process
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </Portal>
  );
};

const Row: React.FC<{
  label: string;
  value: string;
  emphasis?: boolean;
  theme: ReturnType<typeof useTheme>;
}> = ({ label, value, emphasis, theme }) => (
  <View style={styles.row}>
    <Text style={[styles.rowLabel, { color: theme.onSurfaceVariant }]}>
      {label}
    </Text>
    <Text
      style={[
        styles.rowValue,
        {
          color: emphasis ? theme.primary : theme.onSurface,
          fontWeight: emphasis ? '700' : '500',
        },
      ]}
    >
      {value}
    </Text>
  </View>
);

function formatThousands(n: number): string {
  return n.toLocaleString('en-US');
}

const styles = StyleSheet.create({
  sheet: {
    margin: 16,
    borderRadius: 12,
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 14, marginBottom: 12 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  rowLabel: { fontSize: 13 },
  rowValue: { fontSize: 14 },
  note: { fontSize: 12, marginTop: 8, lineHeight: 16 },
  btns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 16,
  },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  confirmBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
});

export default CostPreviewModal;
