import React from 'react';
import { Input } from '../ui/Input';

export interface CursorQuotaConfigProps {
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
}

export const CursorQuotaConfig: React.FC<CursorQuotaConfigProps> = ({ options, onChange }) => {
  const handleChange = (key: string, value: string) => {
    onChange({ ...options, [key]: value });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          Usage endpoint (optional)
        </label>
        <Input
          value={(options.endpoint as string) ?? ''}
          onChange={(e) => handleChange('endpoint', e.target.value)}
          placeholder="https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
        />
        <span className="text-[10px] text-text-muted">
          Cursor dashboard usage URL. Defaults to the Connect-RPC current-period endpoint.
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          Exchange endpoint (optional)
        </label>
        <Input
          value={(options.exchangeEndpoint as string) ?? ''}
          onChange={(e) => handleChange('exchangeEndpoint', e.target.value)}
          placeholder="https://api2.cursor.sh/auth/exchange_user_api_key"
        />
        <span className="text-[10px] text-text-muted">
          User API key exchange URL. Defaults to Cursor's dashboard token exchange.
        </span>
      </div>
    </div>
  );
};
