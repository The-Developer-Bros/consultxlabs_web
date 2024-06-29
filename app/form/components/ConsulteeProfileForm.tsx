// components/ConsulteeProfileForm.tsx
import React from "react";
import { useFormContext } from "react-hook-form";
import { ConsulteeProfile } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const ConsulteeProfileForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<ConsulteeProfile>();

  return (
    <form onSubmit={handleSubmit(onNext)}>
      <div>
        <label>Location</label>
        <input {...register("location")} />
      </div>
      <div>
        <label>Online Status</label>
        <input type="checkbox" {...register("onlineStatus")} />
        {errors.onlineStatus && <p>{errors.onlineStatus.message}</p>}
      </div>
      <button type="button" onClick={onBack}>Back</button>
      <button type="submit">Next</button>
    </form>
  );
};

export default ConsulteeProfileForm;