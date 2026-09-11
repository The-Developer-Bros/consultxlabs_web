"use client";

import Image from "next/image";
import {
  Star,
  MapPin,
  Briefcase,
  Clock,
  CheckCircle2,
  Globe,
  Github,
  Linkedin,
  Twitter,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  reviewCount: number;
}

export function ProfileHeader({
  userDetails,
  consultantDetails,
  reviewCount,
}: ProfileHeaderProps) {
  return (
    <div className="bg-card rounded-2xl border border-border p-6 md:p-8">
      <div className="flex flex-col sm:flex-row gap-6">
        {/* Profile Display Image - Square format */}
        <div className="relative flex-shrink-0">
          {userDetails.profileDisplayImage ? (
            <div className="w-32 h-32 md:w-48 md:h-48 rounded-xl overflow-hidden ring-4 ring-muted relative">
              <Image
                src={userDetails.profileDisplayImage}
                alt={userDetails.name || "Expert"}
                fill
                className="object-cover"
              />
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute bottom-2 right-2 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-card">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </div>
          ) : (
            <>
              <Avatar className="w-24 h-24 md:w-32 md:h-32 ring-4 ring-muted">
                <AvatarImage
                  src={userDetails.image || "/placeholder-user.jpg"}
                  alt={userDetails.name || "Expert"}
                  className="object-cover"
                />
                <AvatarFallback className="text-2xl bg-primary text-primary-foreground">
                  {userDetails.name?.charAt(0) || "E"}
                </AvatarFallback>
              </Avatar>
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-card">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-start gap-3 mb-2">
            <h1 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              {userDetails.name}
            </h1>
            {consultantDetails.headline && (
              <Badge className="bg-primary text-primary-foreground hover:bg-primary/90">
                {consultantDetails.headline}
              </Badge>
            )}
          </div>

          {/* Rating. #705 — the PUBLISHED score, which is null until enough
              distinct sessions have been rated. Rendering the raw mean here
              while the reviews section showed the published one would have made
              the threshold decorative. */}
          <div className="flex items-center gap-3 mb-4">
            {consultantDetails.publishedRating !== null && (
              <>
                <div className="flex items-center gap-1">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-5 h-5 ${
                        i < Math.floor(consultantDetails.publishedRating!)
                          ? "fill-amber-400 text-amber-400"
                          : "fill-muted text-muted"
                      }`}
                    />
                  ))}
                </div>
                <span className="font-semibold text-foreground">
                  {consultantDetails.publishedRating.toFixed(1)}
                </span>
                <span className="text-muted-foreground/70">•</span>
              </>
            )}
            <span className="text-muted-foreground">{reviewCount} reviews</span>
          </div>

          {/* Meta */}
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Briefcase className="w-4 h-4 text-muted-foreground/70" />
              <span>{consultantDetails.domain.name}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="w-4 h-4 text-muted-foreground/70" />
              <span>{consultantDetails.experience} experience</span>
            </div>
            {userDetails.timezone && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="w-4 h-4 text-muted-foreground/70" />
                <span>{userDetails.timezone}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-2 mt-4">
            {consultantDetails.subDomains?.map((subdomain) => (
              <Badge
                key={subdomain.id}
                variant="outline"
                className="border-border text-muted-foreground"
              >
                {subdomain.name}
              </Badge>
            ))}
            {consultantDetails.tags?.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                className="bg-muted text-muted-foreground hover:bg-muted/80"
              >
                {tag.name}
              </Badge>
            ))}
          </div>

          {/* Social Links */}
          {(userDetails.linkedinUrl ||
            consultantDetails.twitterUrl ||
            consultantDetails.githubUrl ||
            consultantDetails.websiteUrl) && (
            <div className="flex flex-wrap gap-3 mt-4">
              {userDetails.linkedinUrl && (
                <a
                  href={userDetails.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Linkedin className="w-4 h-4" />
                  <span>LinkedIn</span>
                </a>
              )}
              {consultantDetails.twitterUrl && (
                <a
                  href={consultantDetails.twitterUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Twitter className="w-4 h-4" />
                  <span>Twitter</span>
                </a>
              )}
              {consultantDetails.githubUrl && (
                <a
                  href={consultantDetails.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Github className="w-4 h-4" />
                  <span>GitHub</span>
                </a>
              )}
              {consultantDetails.websiteUrl && (
                <a
                  href={consultantDetails.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Globe className="w-4 h-4" />
                  <span>Website</span>
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
