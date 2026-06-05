-- Add unique constraint so ON CONFLICT (user_id, hardware_id) works correctly
-- and prevents duplicate device rows from accumulating.
ALTER TABLE device_registrations
  ADD CONSTRAINT device_registrations_user_hardware_unique
  UNIQUE (user_id, hardware_id);
