"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import ConsultantProfileForm from "../components/ConsultantProfileForm";
import ConsulteeProfileForm from "../components/ConsulteeProfileForm";
import PersonalInfoAndRoleForm from "../components/PersonalInfoAndRoleForm";
import StaffProfileForm from "../components/StaffProfileForm";
import {
  ConsultantProfile,
  ConsulteeProfile,
  PersonalInfoAndRole,
  personalInfoAndRoleSchema,
  StaffProfile,
} from "../../../schemas/userSchema";
import PreferredScheduleForm from "../components/PreferredScheduleForm";

type FormData = PersonalInfoAndRole &
  ConsultantProfile &
  ConsulteeProfile &
  StaffProfile;

const MultiStepForm: React.FC = () => {
  const [step, setStep] = useState(0);
  const methods = useForm<FormData>({
    resolver: zodResolver(personalInfoAndRoleSchema),
  });

  const handleNext = async () => {
    const role = methods.getValues().role;
    if (step === 0) {
      if (!role) {
        alert("Please select a role.");
        return;
      }
      const isValid = await methods.trigger();
      if (isValid) setStep(1);
    } else if (step === 1) {
      const isValid = await methods.trigger();
      if (isValid) setStep(2);
    }
  };

  const handleBack = () => setStep((prevStep) => prevStep - 1);

  const handleSubmit = async (data: FormData) => {
    console.log("Final Submitted Data:", data);
    // try {
    //   const response = await fetch("/api/onboarding", {
    //     method: "POST",
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify(data),
    //   });

    //   if (response.ok) {
    //     // For example, redirect to a dashboard
    //     window.location.href = "/dashboard";
    //   } else {
    //     // Handle errors
    //     console.error("Failed to submit data");
    //   }
    // } catch (error) {
    //   console.error("An error occurred during submission:", error);
    // }
  };

  const renderFormStep = () => {
    const role = methods.getValues().role;
    switch (step) {
      case 0:
        return <PersonalInfoAndRoleForm onNext={handleNext} />;
      case 1:
        switch (role) {
          case "CONSULTANT":
            return (
              <ConsultantProfileForm onNext={handleNext} onBack={handleBack} />
            );
          case "CONSULTEE":
            return (
              <ConsulteeProfileForm onNext={handleNext} onBack={handleBack} />
            );
          case "STAFF":
            return (
              <StaffProfileForm
                onSubmit={methods.handleSubmit(handleSubmit)}
                onBack={handleBack}
              />
            );
          default:
            return null;
        }
      case 2:
        if (role === "CONSULTANT") {
          return (
            <PreferredScheduleForm
              onSubmit={methods.handleSubmit(handleSubmit)}
              onBack={handleBack}
            />
          );
        }
        return null;
      default:
        return null;
    }
  };

  return (
    <FormProvider {...methods}>
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <Header />
        <ProgressIndicator currentStep={step} />
        <WelcomeMessage />
        {renderFormStep()}
      </div>
    </FormProvider>
  );
};

const Header = () => (
  <header className="flex items-center space-x-2 mb-8">
    <LogInIcon className="w-8 h-8 text-primary" />
    <h1 className="text-2xl font-bold">ConsultX</h1>
  </header>
);

const ProgressIndicator = ({ currentStep }: { currentStep: number }) => (
  <div className="flex items-center space-x-4 mb-8">
    {[1, 2, 3, 4].map((step) => (
      <React.Fragment key={step}>
        <StepCircle step={step} currentStep={currentStep} />
        {step < 4 && <div className="w-10 h-0.5 bg-gray-300" />}
      </React.Fragment>
    ))}
  </div>
);

const StepCircle = ({
  step,
  currentStep,
}: {
  step: number;
  currentStep: number;
}) => (
  <div
    className={`flex items-center justify-center w-10 h-10 rounded-full ${
      currentStep + 1 >= step
        ? "bg-black text-white"
        : "bg-gray-200 text-gray-500"
    }`}
  >
    {step}
  </div>
);

const WelcomeMessage = () => (
  <div className="text-center mb-8">
    <h2 className="text-2xl font-bold">Welcome! First things first...</h2>
    <p className="text-muted-foreground">You can always change them later.</p>
  </div>
);

function LogInIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" x2="3" y1="12" y2="12" />
    </svg>
  );
}

export default MultiStepForm;
