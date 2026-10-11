import {createContext,useContext} from 'react';
import type {RoundtableSource} from '../shared/roundtable';
export const RoundtableNavigation=createContext<((source:RoundtableSource)=>void)|undefined>(undefined);
export const useRoundtableNavigation=()=>useContext(RoundtableNavigation);
