export interface VerifyIssue {
  file: string;
  line: number;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
}
