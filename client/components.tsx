import type { PluginTheme } from '@getpaseo/plugin';
import { Icon, TextInput } from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

export const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function appUrl(targetHost: '127.0.0.1' | '::1', port: number): string {
  return `http://${targetHost === '::1' ? '[::1]' : targetHost}:${port}`;
}

export function Btn({ theme, label, onPress, kind = 'secondary', disabled = false, busy = false, small = false, icon }: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  icon?: string;
}) {
  const off = disabled || busy;
  const fg = kind === 'primary' ? theme.colors.accentForeground
    : kind === 'danger' ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={off}
      onPress={onPress}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
        paddingVertical: small ? 4 : 7, paddingHorizontal: small ? 8 : 12, borderRadius: 6,
        backgroundColor: kind === 'primary' ? theme.colors.accent : theme.colors.surface2,
        borderWidth: 1, borderColor: kind === 'primary' ? theme.colors.accent : theme.colors.border,
        opacity: off ? 0.5 : 1,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={fg} />
        : icon ? <Icon name={icon} size={small ? 12 : 14} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: small ? 12 : 13, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function KV({ theme, label, value, children }: {
  theme: PluginTheme;
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
      {value !== undefined
        ? <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1, textAlign: 'right' }}>{value}</Text>
        : children}
    </View>
  );
}

export function ErrorNote({ theme, text }: { theme: PluginTheme; text: string }) {
  return <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{text}</Text>;
}

export function PortInput({ theme, value, onChange, disabled }: {
  theme: PluginTheme;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      keyboardType="number-pad"
      autoCorrect={false}
      style={{
        borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, minWidth: 90,
        paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, textAlign: 'right',
        color: theme.colors.foreground, backgroundColor: theme.colors.surface2,
      }}
    />
  );
}
