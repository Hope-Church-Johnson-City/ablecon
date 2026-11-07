"""Ablcon Remote Script for Ableton Live 11 and 12.

Copy this "Ablcon" folder into Live's User Library under "Remote Scripts",
restart Live, then pick "Ablcon" as a Control Surface in Settings > Link, Tempo & MIDI.
"""
from .surface import AblconSurface


def create_instance(c_instance):
    return AblconSurface(c_instance)
