/** The privacy mode switch with its explanation; used on the lobby and the call page. */
export function PrivacyModeSwitch(props: {
  isPrivacyModeOn: boolean;
  onChange(newIsPrivacyModeOn: boolean): void;
  /** On the call page: a change only applies from the next call or reconnect. */
  isChangeAppliedLater?: boolean;
}) {
  return (
    <div className="privacy-mode-switch">
      <label>
        <input
          type="checkbox"
          role="switch"
          checked={props.isPrivacyModeOn}
          onChange={(changeEvent) => props.onChange(changeEvent.target.checked)}
        />
        Privacy mode
      </label>
      <p>
        Hides your IP address from the other person by sending the call through our relay. It may
        use more data and add a little delay.
      </p>
      <p>
        It only hides your IP address. The other person decides for themselves, and our relay still
        sees both IP addresses.
      </p>
      {props.isChangeAppliedLater && (
        <p>A change applies from the next call or reconnect, not to the current connection.</p>
      )}
    </div>
  );
}
