import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  claudeAccountsRead,
  claudeAccountsSelect,
  claudeQuotaRead,
} from "../shared/claude-account-contracts";

export function ClaudeAccountSettings({
  host,
  theme,
  onClose,
}: Pick<PluginSurfaceProps, "host" | "theme"> & { onClose: () => void }) {
  const read = useRpc(claudeAccountsRead);
  const quotaRead = useRpc(claudeQuotaRead);
  const quota = useQuery({
    queryKey: ["alliance-claude-quota", host.id],
    queryFn: () => quotaRead({}),
    retry: false,
    refetchInterval: 60000,
  });
  const select = useRpc(claudeAccountsSelect);
  const state = useQuery({
    queryKey: ["alliance-claude-accounts", host.id],
    queryFn: () => read({}),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 13 };
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const config = state.data?.config;
  return (
    <Modal
      open
      title={`Claude accounts · ${host.label}`}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16 }}>
        <ScrollView contentContainerStyle={{ gap: 14 }}>
          <Text style={muted}>
            Applies only to this host. Select another Paseo host to configure its accounts.
          </Text>
          <Text style={muted}>
            Selections apply to newly started Claude processes. Running processes retain their current
            credential until they exit; saving never stops or resumes an agent. A resumed session may reuse
            its existing process.
          </Text>
          {(error || state.error) && (
            <Text accessibilityRole="alert" style={text}>
              {error || "Unable to load accounts. Update the host plugin or retry."}
            </Text>
          )}
          {!state.data && !state.error && <Text style={text}>Loading…</Text>}
          {config &&
            (["default", "hq", "supervisor", "lead", "peer", "lens"] as const).map((role) => {
              const selected = role === "default" ? config.defaultAccount : (config.roles[role] ?? "inherit");
              return (
                <View key={role} style={{ gap: 6 }}>
                  <Text style={text}>
                    {role === "default" ? "Host default" : role.toUpperCase()} · next process:{" "}
                    {selected === "inherit" ? config.defaultAccount : selected}
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {(
                      [...(role === "default" ? [] : ["inherit" as const]), "legacy", "5x", "20x"] as const
                    ).map((account) => {
                      const available =
                        account === "inherit" || account === "legacy" || config.accounts.includes(account);
                      return (
                        <Pressable
                          key={account}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: selected === account,
                            disabled: busy || !available,
                          }}
                          disabled={busy || !available}
                          style={{
                            padding: 9,
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: selected === account ? c.accent : c.border,
                            opacity: available ? 1 : 0.45,
                          }}
                          onPress={() => {
                            setBusy(true);
                            setError("");
                            void select({ role, account, revision: state.data!.revision })
                              .then(() => state.refetch())
                              .catch(() =>
                                setError(
                                  "Account selection failed. Check host credential storage, reload, and retry.",
                                ),
                              )
                              .finally(() => setBusy(false));
                          }}
                        >
                          <Text style={text}>
                            {account === "legacy"
                              ? "Existing role login"
                              : account === "inherit"
                                ? "Host default"
                                : `Claude ${account}${available ? "" : " · not provisioned"}`}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          <Text style={text}>Account quota · {host.label}</Text>
          <Text style={muted}>
            Reads this host’s registered OAuth profiles. Quota covers the account’s usage across machines.
            Setup-token credentials cannot read quota.
          </Text>
          {quota.isLoading && <Text style={muted}>Loading quota…</Text>}
          {quota.error && (
            <Text accessibilityRole="alert" style={text}>
              Quota refresh failed. Check the host connection and quota registry.
            </Text>
          )}
          {quota.data && (
            <Text style={muted}>
              Last fetched: {new Date(quota.data.fetchedAt).toLocaleString()}
              {quota.error ? " · stale" : ""}
            </Text>
          )}
          {quota.data?.accounts.length === 0 && (
            <Text style={muted}>
              No OAuth profiles registered on this host. Open this panel on MBP to view its 5x/20x logins.
            </Text>
          )}
          {quota.data?.accounts.map((account) => (
            <View key={account.id} style={{ gap: 5 }}>
              <Text style={text}>{account.label}</Text>
              {account.error && <Text style={muted}>{account.error}</Text>}
              {account.windows.map((window) => (
                <Text key={window.label} style={muted}>
                  {window.label}: {window.usedPct}% used · resets{" "}
                  {window.resetsAt ? new Date(window.resetsAt).toLocaleString() : "unknown"}
                </Text>
              ))}
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            disabled={quota.isFetching}
            onPress={() => void quota.refetch()}
          >
            <Text style={text}>
              {quota.isFetching ? "Refreshing quota…" : "Refresh quota (cached up to 1 minute)"}
            </Text>
          </Pressable>
          <Text style={text}>Provision credentials on {host.label}</Text>
          <Text style={muted}>
            Run these commands in a terminal on this host. The hidden prompt writes to macOS Keychain or Linux
            systemd credentials bound to the user, host key and TPM2. Tokens never pass through plugin RPCs or
            browser storage.
          </Text>
          <Text selectable style={text}>
            {"alliance-work accounts import 5x\nalliance-work accounts import 20x"}
          </Text>
          <Text style={muted}>
            Use the matching account’s setup-token credential. These labels do not verify the subscription
            tier. Quota requires separate Claude OAuth logins on the quota-tracking host.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setError("");
              void state.refetch();
            }}
          >
            <Text style={text}>Reload accounts</Text>
          </Pressable>
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}
