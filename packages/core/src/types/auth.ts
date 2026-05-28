export interface AuthContext {
  /** MVP: 'anonymous'. Team mode: 'bearer' | 'oauth' */
  scheme: "anonymous" | "bearer";
  principal?: string;
}
