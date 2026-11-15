import { useEffect, useState } from "react";
import { Text } from "react-native";
import { relativeTime } from "../shared/monitor";

/** Only mounted time labels tick; a clock never re-renders the entire project board. */
export function ElapsedTime({ timestamp }: { timestamp: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  return <Text>{relativeTime(timestamp, now)}</Text>;
}
