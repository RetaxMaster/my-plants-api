import { SetMetadata } from '@nestjs/common';

// Marks a handler as reachable by a `scope:'doctor'` token. ABSENCE = default-deny for doctor tokens
// (Spec 3 §3.3). Ordinary owner/admin tokens ignore it entirely (they take the normal path).
export const DOCTOR_ALLOWED_KEY = 'doctor_allowed';
export const DoctorAllowed = () => SetMetadata(DOCTOR_ALLOWED_KEY, true);
